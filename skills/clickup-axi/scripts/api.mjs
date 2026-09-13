import { invocation } from './invocation.mjs';
import { readFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { AxiError } from './output.mjs';

function validateToken(token) {
  if (typeof token !== 'string' || !token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) {
    throw new AxiError('A valid ClickUp API token is required.', 'AUTH_REQUIRED', ['Set CLICKUP_API_TOKEN in your environment or .env. Create a personal token in ClickUp Settings > Apps. Never put tokens in arguments, chat, or tracked files.']);
  }
  return token;
}

export function readToken(env, cwd) {
  if (env.CLICKUP_API_TOKEN !== undefined) return validateToken(env.CLICKUP_API_TOKEN);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, '.env');
    let values;
    let found = false;
    try {
      let stat = lstatSync(file);
      found = true;
      if (stat.isSymbolicLink()) stat = statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid .env file');
      values = parseEnv(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' || found) throw new AxiError(`Cannot read ${file} as a .env file.`, 'CONFIG_ERROR', ['Use a regular UTF-8 .env file smaller than 1 MiB. Never commit it.']);
    }
    if (values?.CLICKUP_API_TOKEN !== undefined) return validateToken(values.CLICKUP_API_TOKEN);
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return validateToken(undefined);
  }
}

export function usage(message, help = `Run \`${invocation().command} --help\`.`) {
  throw new AxiError(message, 'VALIDATION_ERROR', [help]);
}

export function numericID(value, name) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) usage(`${name} must be a positive numeric ID.`);
  return value;
}

export function taskID(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) usage('A task ID is required; use an internal ID or a custom ID with --custom.');
  return value;
}

export function projectConfig(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const path = join(dir, '.clickup-axi.json');
    let config;
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new AxiError(`Cannot read ${path}.`, 'CONFIG_ERROR', ['Use a JSON object with string workspace and list IDs. Never store a token here.']);
    }
    if (config !== undefined) {
      if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).some(key => !['workspace', 'list'].includes(key))) {
        usage(`${path} accepts only workspace and list keys.`);
      }
      for (const [key, value] of Object.entries(config)) numericID(value, `Project ${key}`);
      return { ...config, path };
    }
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return {};
  }
}

export function readDefaults(env, cwd) {
  const config = projectConfig(cwd);
  const workspace = env.CLICKUP_WORKSPACE_ID ?? config.workspace;
  const list = env.CLICKUP_LIST_ID ?? config.list;
  if (workspace !== undefined) numericID(workspace, 'CLICKUP_WORKSPACE_ID or project workspace');
  if (list !== undefined) numericID(list, 'CLICKUP_LIST_ID or project list');
  return { workspace, list, source: config.path ?? 'environment' };
}

export function requireArray(data, key) {
  if (!Array.isArray(data?.[key])) throw new AxiError(`ClickUp returned an invalid ${key} response.`, 'API_RESPONSE', ['Try the read command again.']);
  return data[key];
}

export function requireTask(data) {
  if (!data || typeof data.id !== 'string' || typeof data.name !== 'string') {
    throw new AxiError('ClickUp did not return a valid task.', 'API_RESPONSE', ['Read the task state before repeating a write. A create may already have succeeded.']);
  }
  return data;
}

export function createClient({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, timeoutMs = 15000, bin = invocation().command } = {}) {
  let token;
  return async function request(method, path, query = {}, body, version = 'v2') {
    token ??= readToken(env, cwd);
    if (!['v2', 'v3'].includes(version)) usage('Unsupported ClickUp API version.');
    const url = new URL(`https://api.clickup.com/api/${version}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const write = method !== 'GET';
    const recovery = write
      ? 'The write may have succeeded. Read the task or comments before retrying; do not repeat a create, comment, or description append blindly.'
      : 'Check your connection and try the read command again.';
    let response;
    let data;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: token, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      // Never print raw response bodies, which can contain credentials or HTML.
      if (response.ok) {
        const text = await response.text();
        data = text ? JSON.parse(text) : write ? {} : null;
      }
    } catch {
      throw new AxiError('ClickUp could not return a complete response (network error, timeout, or invalid JSON).', 'REQUEST_FAILED', [recovery]);
    }
    if (!response.ok) {
      const status = response.status;
      const errors = {
        400: ['ClickUp rejected the supplied fields.', `Check IDs and field values. Use \`${bin} list <id>\` to see allowed statuses.`],
        401: ['ClickUp rejected your API token.', 'Check CLICKUP_API_TOKEN in your environment or .env. A rejected environment token does not select a .env token.'],
        403: ['You do not have access to this ClickUp resource.', 'Check your workspace and resource permissions.'],
        404: ['The ClickUp resource was not found.', 'Check the ID. Custom task IDs require --custom and a workspace.'],
      };
      if (status === 429) {
        const retry = response.headers.get('retry-after');
        const wait = retry && /^\d+$/.test(retry) ? `Wait ${retry} seconds` : 'Wait for the ClickUp rate limit to reset';
        throw new AxiError('ClickUp rate limit reached.', 'RATE_LIMITED', [`${wait}, then retry. No automatic retry was made.`]);
      }
      const [message, hint] = errors[status] ?? [`ClickUp request failed (HTTP ${status}).`, recovery];
      throw new AxiError(message, `HTTP_${status}`, [hint]);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AxiError('ClickUp returned an invalid response.', 'API_RESPONSE', [recovery]);
    return data;
  };
}
