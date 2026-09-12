import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxiError, runAxiCli, installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from 'axi-sdk-js';
import { createClient, numericID, taskID, readDefaults, requireArray, requireTask, usage } from './api.js';
import { BOOLEAN_FLAGS, COMMANDS, DESCRIPTION, GUIDANCE, TOP_LEVEL_HELP, commandHelp } from './help.js';
import { VERSION } from './version.js';

const ENTRY = fileURLToPath(new URL('../bin/clickup-axi.js', import.meta.url));
const FIELDS = ['id', 'name', 'status', 'list', 'custom_id', 'priority', 'assignees', 'due_date', 'url', 'parent'];
const PRIORITIES = { urgent: 1, high: 2, normal: 3, low: 4, none: null };

function integer(value, name, min, max) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) usage(`${name} must be an integer from ${min} to ${max}.`);
  return Number(value);
}

export function parseCommand(command, argv) {
  if (command === 'task' && ['create', 'update', 'comment'].includes(argv[0])) {
    command += ` ${argv[0]}`;
    argv = argv.slice(1);
  }
  const spec = COMMANDS[command];
  const known = [...Object.keys(spec.flags), 'help'];
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options: Object.fromEntries(known.map(key => [key, { type: BOOLEAN_FLAGS.has(key) ? 'boolean' : 'string' }])) });
  } catch (error) {
    usage(error.message, `Valid flags for ${command}: ${known.map(key => `--${key}`).join(', ')}. Run \`clickup-axi ${command} --help\`.`);
  }
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) usage(`--${token.name} was supplied more than once.`);
    seen.add(token.name);
  }
  const flags = parsed.values;
  const args = parsed.positionals;
  if (flags.help) return { command, flags, args };
  const arity = ['task', 'task update', 'task comment', 'comments', 'list', 'search', 'setup'].includes(command) ? 1 : 0;
  if (args.length !== arity) usage(`Expected ${arity} argument(s) for ${command}.`, `Run \`clickup-axi ${spec.usage}\`.`);
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value === 'string' && !value.trim() && key !== 'description') usage(`--${key} must not be empty.`);
  }
  for (const key of ['workspace', 'list', 'space', 'folder']) {
    if (flags[key] !== undefined) numericID(flags[key], `--${key}`);
  }
  if (['task', 'task update', 'task comment', 'comments'].includes(command)) taskID(args[0]);
  if (command === 'list') numericID(args[0], 'List ID');
  if (flags.parent !== undefined) taskID(flags.parent);
  if (command === 'folders' && !flags.space) usage('--space is required.', 'Run `clickup-axi spaces` to find a Space ID.');
  if (command === 'lists' && Boolean(flags.space) === Boolean(flags.folder)) usage('Use exactly one of --space or --folder.', 'Run `clickup-axi folders --space <id>` to find Folders.');
  if (command === 'setup' && !['hooks', 'status', 'remove'].includes(args[0])) usage('Use setup hooks, setup status, or setup remove.');
  if (command === 'task create' && !flags.name) usage('--name is required.', 'Run `clickup-axi task create --list <id> --name "<name>"`.');
  if (command === 'task comment' && !flags.text) usage('--text is required.', 'Run `clickup-axi task comment <id> --text "<text>"`.');
  if (command === 'search' && !args[0].trim()) usage('Search words must not be empty.');
  if (Boolean(flags.start) !== Boolean(flags['start-id'])) usage('--start and --start-id must be used together.');
  if (flags.start !== undefined) numericID(flags.start, '--start');
  if (flags['start-id'] !== undefined) numericID(flags['start-id'], '--start-id');
  for (const [key, min, max, fallback] of [['page', 0, 1000000, 0], ['pages', 1, 100, 5], ['limit', 1, 100, 100], ['offset', 0, 10000, 0], ['max-chars', 1, 100000, 1000]]) {
    if (key in spec.flags) flags[key] = integer(flags[key] ?? String(fallback), `--${key}`, min, max);
  }
  if (flags.fields !== undefined) {
    flags.fields = flags.fields.split(',');
    if (flags.fields.some(field => !FIELDS.includes(field)) || new Set(flags.fields).size !== flags.fields.length) usage('Invalid or duplicate task fields.', `Valid fields: ${FIELDS.join(', ')}.`);
  }
  if (flags.assignee !== undefined && !(['tasks', 'search'].includes(command) && ['me', 'all'].includes(flags.assignee))) {
    integer(numericID(flags.assignee, '--assignee'), '--assignee', 1, Number.MAX_SAFE_INTEGER);
  }
  if (flags.unassign !== undefined) integer(numericID(flags.unassign, '--unassign'), '--unassign', 1, Number.MAX_SAFE_INTEGER);
  if (flags.assignee && flags.assignee === flags.unassign) usage('Cannot add and remove the same assignee.');
  if (flags.priority !== undefined && !Object.hasOwn(PRIORITIES, flags.priority)) usage('--priority must be urgent, high, normal, low, or none.');
  if (flags.due !== undefined && flags.due !== 'none') {
    const date = new Date(`${flags.due}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.due) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== flags.due) usage('--due must be a real YYYY-MM-DD date or none.');
  }
  if (command === 'task update' && !['name', 'description', 'status', 'priority', 'due', 'assignee', 'unassign'].some(key => flags[key] !== undefined)) usage('Supply at least one task field to update.', 'Run `clickup-axi task update --help`.');
  return { command, flags, args };
}

function preview(value, flags) {
  const chars = Array.from(String(value ?? ''));
  const truncated = !flags.full && chars.length > (flags['max-chars'] ?? 1000);
  return {
    text: truncated ? `${chars.slice(0, flags['max-chars'] ?? 1000).join('')}... (truncated, ${chars.length} chars total; use --full)` : chars.join(''),
    truncated,
  };
}

function isoDate(value) {
  if (value == null) return null;
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function taskRow(task, fields = ['id', 'name', 'status', 'list']) {
  const row = {
    id: task.id, name: task.name, status: task.status?.status ?? null, list: task.list?.name ?? task.list?.id ?? null,
    custom_id: task.custom_id ?? null, priority: task.priority?.priority ?? null,
    assignees: (task.assignees ?? []).map(user => user.username ?? String(user.id)).join(', '),
    due_date: isoDate(task.due_date), url: task.url ?? null, parent: task.parent ?? null,
  };
  return Object.fromEntries(fields.map(field => [field, row[field]]));
}

function collection(key, rows, help = []) {
  return { count: rows.length, totalCount: rows.length, ...(rows.length ? {} : { message: `0 ${key} found.` }), [key]: rows, ...(help.length ? { help } : {}) };
}

function scopeFlags(flags) {
  return `${flags.custom ? ' --custom' : ''}${flags.workspace ? ` --workspace ${flags.workspace}` : ''}`;
}

function pageHint(command, flags, page) {
  const parts = [`clickup-axi ${command}`, `--page ${page}`];
  for (const key of ['workspace', 'list', 'space', 'assignee', 'status', 'tag', 'include-closed', 'pages', 'fields']) {
    const value = flags[key];
    if (value !== undefined) parts.push(`--${key}${value === true ? '' : ` ${shellQuote(Array.isArray(value) ? value.join(',') : String(value))}`}`);
  }
  return parts.join(' ');
}

function shellQuote(value) {
  return /^[\w.-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function createApp({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, homeDir, execPath = ENTRY, timeoutMs } = {}) {
  const api = createClient({ env, fetchImpl, timeoutMs });
  let userPromise;
  let teamsPromise;
  const user = () => userPromise ??= api('GET', 'user').then(data => {
    if (!data.user?.id) throw new AxiError('ClickUp returned an invalid user.', 'API_RESPONSE');
    return data.user;
  });
  const teams = () => teamsPromise ??= api('GET', 'team').then(data => requireArray(data, 'teams'));
  const defaults = () => readDefaults(env, cwd);

  async function workspace(selected) {
    if (selected) return selected;
    const rows = await teams();
    if (rows.length !== 1) throw new AxiError(`Select a workspace; ${rows.length} are available.`, 'WORKSPACE_REQUIRED', ['Run `clickup-axi workspaces`, then use --workspace <id> or set CLICKUP_WORKSPACE_ID.']);
    return numericID(String(rows[0].id), 'Workspace ID');
  }

  async function taskQuery(flags) {
    if (!flags.custom) return {};
    flags.workspace = await workspace(flags.workspace ?? defaults().workspace);
    return { custom_task_ids: true, team_id: flags.workspace };
  }

  async function taskList(flags, words) {
    const config = defaults();
    flags.list ??= config.list;
    flags.assignee ??= 'me';
    flags.workspace ??= config.workspace;
    // A List-only query needs no workspace lookup. An explicit workspace must still constrain the query.
    const listOnly = flags.list && !flags.workspace && !flags.space;
    if (!listOnly) flags.workspace = await workspace(flags.workspace);
    const assignee = flags.assignee === 'me' ? String((await user()).id) : flags.assignee;
    const path = listOnly ? `list/${flags.list}/task` : `team/${flags.workspace}/task`;
    const query = {
      subtasks: true, include_closed: flags['include-closed'] ?? false, order_by: 'updated', reverse: true,
      ...(path.startsWith('list/') ? { include_timl: true, archived: false } : {}),
      'assignees[]': assignee === 'all' ? undefined : assignee,
      'statuses[]': flags.status, 'tags[]': flags.tag,
      'list_ids[]': path.startsWith('team/') ? flags.list : undefined,
      'space_ids[]': flags.space,
    };
    const matches = new Map();
    let scanned = 0;
    let pages = 0;
    let hasMore = true;
    const firstPage = flags.page ?? 0;
    const terms = words?.toLowerCase().split(/\s+/).filter(Boolean);
    // ponytail: local search scans at most 5 pages by default; narrow filters or raise --pages for larger workspaces.
    while (hasMore && pages < (words === undefined ? 1 : flags.pages)) {
      const data = await api('GET', path, { ...query, page: firstPage + pages });
      const tasks = requireArray(data, 'tasks');
      for (const task of tasks) {
        requireTask(task);
        const content = `${task.name}\n${task.description ?? task.text_content ?? ''}`.toLowerCase();
        if (!terms || terms.every(term => content.includes(term))) matches.set(task.id, task);
      }
      scanned += tasks.length;
      pages++;
      hasMore = typeof data.last_page === 'boolean' ? !data.last_page : tasks.length >= 100;
    }
    const rows = [...matches.values()];
    const offset = flags.offset ?? 0;
    const shown = rows.slice(offset, offset + (flags.limit ?? 100));
    const nextOffset = offset + shown.length < rows.length ? offset + shown.length : null;
    const complete = firstPage === 0 && !hasMore;
    const help = [`Run \`clickup-axi task <id>${scopeFlags(flags)}\` for details.`];
    const command = words === undefined ? 'tasks' : `search ${shellQuote(words)}`;
    if (nextOffset !== null) help.push(words === undefined
      ? `Run \`${pageHint(command, flags, firstPage)} --limit 100\` for every task on this API page.`
      : `Run \`${pageHint(command, flags, firstPage)} --offset ${nextOffset}\` for the remaining matches in this scan.`);
    if (hasMore) help.push(`Run \`${pageHint(command, flags, firstPage + pages)}\` for the next API page.`);
    if (!rows.length) help.push('Try --include-closed or --assignee all to widen the same scope.');
    return {
      scope: { workspace: flags.workspace ?? null, list: flags.list ?? null, space: flags.space ?? null, assignee: flags.assignee, status: flags.status ?? null, tag: flags.tag ?? null, includeClosed: flags['include-closed'] ?? false },
      count: shown.length, totalCount: complete ? rows.length : null,
      matchedInScan: rows.length, scanned, firstPage, pages, hasMore,
      ...(hasMore ? { nextPage: firstPage + pages } : {}),
      ...(words === undefined ? {} : { offset, nextOffset }),
      ...(shown.length ? {} : { message: words === undefined ? '0 tasks on this page in this scope.' : `0 matches at this offset in the scanned pages.${hasMore ? ' Unscanned pages may contain matches.' : ''}` }),
      tasks: shown.map(task => taskRow(task, flags.fields)),
      help,
    };
  }

  async function commentPage(id, flags, limit = 25, query) {
    const data = await api('GET', `task/${id}/comment`, { ...(query ?? await taskQuery(flags)), start: flags.start, start_id: flags['start-id'] });
    const rows = requireArray(data, 'comments');
    const shown = rows.slice(0, limit);
    const previews = shown.map(comment => preview(comment.comment_text ?? comment.comment?.map(part => part.text ?? '').join(''), flags));
    const hasMore = rows.length >= 25 || rows.length > shown.length;
    const last = shown.at(-1);
    const next = hasMore && last ? { start: String(last.date), startId: String(last.id) } : null;
    if (next) {
      numericID(next.start, 'Comment cursor timestamp');
      numericID(next.startId, 'Comment cursor ID');
    }
    const suffix = scopeFlags(flags);
    const help = [];
    if (next) help.push(`Run \`clickup-axi comments <id>${suffix} --start ${next.start} --start-id ${next.startId}\` for older comments.`);
    if (previews.some(item => item.truncated)) help.push(`Run \`clickup-axi comments <id>${suffix}${flags.start ? ` --start ${flags.start} --start-id ${flags['start-id']}` : ''} --full\` for complete comment text.`);
    return {
      count: shown.length, totalCount: !flags.start && !hasMore ? rows.length : null, hasMore, next,
      ...(rows.length ? {} : { message: '0 comments on this page.' }),
      comments: shown.map((comment, index) => ({ id: String(comment.id), author: comment.user?.username ?? null, date: isoDate(comment.date), text: previews[index].text })),
      ...(help.length ? { help } : {}),
    };
  }

  async function taskWrite(command, id, flags) {
    if (command === 'task create') {
      flags.list ??= defaults().list;
      if (!flags.list) usage('--list is required, or set a project default.', 'Run `clickup-axi lists --space <id>` to find a List.');
    }
    const query = command === 'task create' ? {} : await taskQuery(flags);
    if (command === 'task comment') {
      const body = { comment_text: flags.text, notify_all: flags.notify ?? false };
      if (flags['dry-run']) return { dryRun: true, task: id, body };
      const data = await api('POST', `task/${id}/comment`, query, body);
      if (!data.id) throw new AxiError('ClickUp did not return a comment ID. The comment may exist.', 'API_RESPONSE', ['Read `clickup-axi comments <id>` before retrying.']);
      return { action: 'commented', task: id, comment: { id: String(data.id) }, help: [`Run \`clickup-axi comments <id>${scopeFlags(flags)}\` to read comments.`] };
    }
    const body = {};
    for (const key of ['name', 'description', 'status', 'parent']) if (flags[key] !== undefined) body[key] = flags[key];
    if (flags.priority !== undefined) body.priority = PRIORITIES[flags.priority];
    if (flags.due !== undefined) {
      body.due_date = flags.due === 'none' ? null : new Date(`${flags.due}T00:00:00.000Z`).getTime();
      // Untimed ClickUp dates shift to 4am in the creator's timezone. Use an explicit UTC instant.
      body.due_date_time = flags.due !== 'none';
    }
    if (command === 'task create') {
      if (flags.assignee) body.assignees = [Number(flags.assignee)];
      if (flags['dry-run']) return { dryRun: true, list: flags.list, body };
      const task = requireTask(await api('POST', `list/${flags.list}/task`, {}, body));
      return { action: 'created', task: taskRow(task, FIELDS), help: ['Run `clickup-axi task <id>` for details.'] };
    }
    const current = requireTask(await api('GET', `task/${id}`, query));
    const description = current.description ?? current.text_content ?? '';
    const existing = { name: current.name, description: description.trim() ? description : '', status: current.status?.status, priority: current.priority ? Number(current.priority.id) : null, due_date: current.due_date == null ? null : Number(current.due_date) };
    if (body.due_date === existing.due_date) {
      delete body.due_date;
      delete body.due_date_time;
    }
    for (const key of ['name', 'description', 'status', 'priority']) if (body[key] === existing[key]) delete body[key];
    const assigned = new Set((current.assignees ?? []).map(person => String(person.id)));
    const add = flags.assignee && !assigned.has(flags.assignee) ? [Number(flags.assignee)] : [];
    const rem = flags.unassign && assigned.has(flags.unassign) ? [Number(flags.unassign)] : [];
    if (add.length || rem.length) body.assignees = { add, rem };
    // ClickUp documents a single space, not an empty string, as the clear-description payload.
    if (body.description === '') body.description = ' ';
    const changed = Object.keys(body).length > 0;
    if (flags['dry-run']) return { dryRun: true, task: id, changed, body };
    const task = changed ? requireTask(await api('PUT', `task/${id}`, query, body)) : current;
    return { action: changed ? 'updated' : 'unchanged', changed, task: taskRow(task, FIELDS), help: [`Run \`clickup-axi task <id>${scopeFlags(flags)}\` for details.`] };
  }

  async function execute(command, argv = []) {
    const parsed = parseCommand(command, argv);
    command = parsed.command;
    const { flags, args } = parsed;
    if (flags.help) return commandHelp(command);
    const id = args[0];
    if (command === 'setup') {
      const errors = [];
      const options = { marker: 'clickup-axi', binaryNames: ['clickup-axi'], distEntrypoints: ['bin/clickup-axi.js'], execPath: resolve(execPath), scope: flags.global ? 'user' : 'project', projectDir: cwd, homeDir, timeoutSeconds: 10, onError: message => errors.push(`Check permissions and JSON syntax in ${message.split(': ')[0]}.`) };
      if (id === 'hooks') {
        // ponytail: the SDK shares a raw path between shell hooks and spawn; require a shell-safe install path until it supports per-host quoting.
        if (!/^[\w/.:\\-]+$/.test(options.execPath)) usage('Hook installation requires a path without spaces or shell symbols.', 'Move this checkout to a path without spaces or shell symbols, then run `clickup-axi setup hooks`.');
        installSessionStartHooks(options);
      }
      if (id === 'remove') uninstallSessionStartHooks(options);
      if (errors.length) throw new AxiError('Agent setup was only partly applied.', 'SETUP_ERROR', [...errors, 'Fix the listed configuration files, then run the same setup command again.']);
      return { setup: id, ...sessionStartHookStatus(options) };
    }
    if (command === 'update') return { message: 'This is a local package; no update was installed.', help: ['In your checkout, run `npm install --ignore-scripts` and `npm install -g .`.'] };
    if (command === 'home') {
      const config = defaults();
      const selected = { workspace: flags.workspace ?? config.workspace, list: flags.list ?? config.list, limit: 5, page: 0 };
      if (selected.workspace || selected.list) {
        const tasks = await taskList(selected);
        return { project: config.source, ...tasks };
      }
      return { ...collection('workspaces', (await teams()).map(team => ({ id: String(team.id), name: team.name }))), help: ['Run `clickup-axi tasks --workspace <id>` for your open tasks.', 'Set workspace and list string IDs in .clickup-axi.json for a project task dashboard.', ...GUIDANCE.slice(-1)] };
    }
    if (command === 'workspaces') return collection('workspaces', (await teams()).map(team => ({ id: String(team.id), name: team.name })), ['Run `clickup-axi spaces --workspace <id>` to find Spaces.']);
    if (command === 'members' || command === 'spaces') {
      const selected = await workspace(flags.workspace ?? defaults().workspace);
      if (command === 'members') {
        const team = (await teams()).find(item => String(item.id) === selected);
        if (!team) throw new AxiError('Workspace is not authorized.', 'WORKSPACE_REQUIRED', ['Run `clickup-axi workspaces`.']);
        return { workspace: selected, ...collection('members', requireArray(team, 'members').map(({ user }) => ({ id: String(user.id), name: user.username, email: user.email })), [`Run \`clickup-axi tasks --workspace ${selected} --assignee <id>\` to read a member's tasks.`]) };
      }
      const data = await api('GET', `team/${selected}/space`, { archived: false });
      return { workspace: selected, ...collection('spaces', requireArray(data, 'spaces').map(space => ({ id: String(space.id), name: space.name, private: space.private ?? false })), ['Run `clickup-axi folders --space <id>` for Folders.', 'Run `clickup-axi lists --space <id>` for folderless Lists.']) };
    }
    if (command === 'folders' || command === 'lists') {
      const path = command === 'folders' ? `space/${flags.space}/folder` : flags.folder ? `folder/${flags.folder}/list` : `space/${flags.space}/list`;
      const key = command;
      const data = await api('GET', path, { archived: false });
      return { scope: flags.folder ? { folder: flags.folder } : { space: flags.space, ...(key === 'lists' ? { folderless: true } : {}) }, ...collection(key, requireArray(data, key).map(item => ({ id: String(item.id), name: item.name, ...(key === 'lists' ? { taskCount: item.task_count == null ? null : Number(item.task_count) } : {}) })), key === 'folders' ? ['Run `clickup-axi lists --folder <id>` for Lists in a Folder.'] : ['Run `clickup-axi list <id>` for allowed statuses.', 'Run `clickup-axi tasks --list <id>` for your open tasks.']) };
    }
    if (command === 'list') {
      const data = await api('GET', `list/${id}`);
      const body = preview(data.content, flags);
      return { list: { id: String(data.id), name: data.name, taskCount: data.task_count == null ? null : Number(data.task_count), description: body.text }, statuses: requireArray(data, 'statuses').map(status => ({ name: status.status, type: status.type })), help: ['Run `clickup-axi task create --list <id> --name "<name>"` to add a task.', ...(body.truncated ? ['Run `clickup-axi list <id> --full` for the full description.'] : [])] };
    }
    if (command === 'tasks' || command === 'search') return taskList(flags, command === 'search' ? id : undefined);
    if (command.startsWith('task ')) return taskWrite(command, id, flags);
    if (command === 'comments') return commentPage(id, flags);
    const query = await taskQuery(flags);
    const data = requireTask(await api('GET', `task/${id}`, query));
    const body = preview(data.description ?? data.text_content, flags);
    const comments = await commentPage(id, flags, 5, query);
    const help = [...(comments.help ?? [])];
    if (body.truncated) help.push(`Run \`clickup-axi task <id>${scopeFlags(flags)} --full\` for the full description.`);
    delete comments.help;
    return { task: { ...taskRow(data, FIELDS), list: data.list ? { id: String(data.list.id), name: data.list.name } : null, description: body.text }, comments, ...(help.length ? { help } : {}) };
  }
  return { execute };
}

export async function main(argv, options = {}) {
  const { execute } = createApp(options);
  await runAxiCli({
    argv, version: VERSION, description: DESCRIPTION, topLevelHelp: TOP_LEVEL_HELP,
    stdout: options.stdout,
    home: () => execute('home'),
    commands: Object.assign(Object.create(null), Object.fromEntries(Object.keys(COMMANDS).filter(key => !key.includes(' ')).map(key => [key, args => execute(key, args)]))),
  });
}
