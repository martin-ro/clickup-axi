import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AxiError } from 'axi-sdk-js';

export function usage(message, help = 'Run `clickup-axi --help`.') {
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

export function createClient({ env = process.env, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  return async function request(method, path, query = {}, body) {
    const token = env.CLICKUP_API_TOKEN ?? env.CLICKUP_TOKEN;
    if (!token || /[\s\x00-\x1f\x7f]/.test(token)) {
      throw new AxiError('Set CLICKUP_API_TOKEN to a valid ClickUp API token.', 'AUTH_REQUIRED', ['Create a personal token in ClickUp Settings > Apps. Keep it in your environment, not in command arguments or project files.']);
    }
    const url = new URL(`https://api.clickup.com/api/v2/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const write = method !== 'GET';
    const recovery = write
      ? 'The write may have succeeded. Read the task or comments before retrying; do not repeat a create or comment blindly.'
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
      if (response.ok) data = await response.json();
    } catch {
      throw new AxiError('ClickUp could not return a complete response (network error, timeout, or invalid JSON).', 'REQUEST_FAILED', [recovery]);
    }
    if (!response.ok) {
      const status = response.status;
      const errors = {
        400: ['ClickUp rejected the supplied fields.', 'Check IDs and field values. Use `clickup-axi list <id>` to see allowed statuses.'],
        401: ['ClickUp rejected your API token.', 'Set CLICKUP_API_TOKEN to a current token.'],
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
