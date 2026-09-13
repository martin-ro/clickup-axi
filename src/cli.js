import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AxiError, renderOutput } from './output.js';
import { setupHooks } from './hooks.js';
import { createClient, numericID, taskID, readDefaults, requireArray, requireTask, usage } from './api.js';
import { BOOLEAN_FLAGS, COMMANDS, DESCRIPTION, GUIDANCE, TOP_LEVEL_HELP, commandHelp } from './help.js';
import { VERSION } from './version.js';

const ENTRY = fileURLToPath(new URL('../bin/clickup-axi.js', import.meta.url));
const FIELDS = ['id', 'name', 'status', 'list', 'custom_id', 'priority', 'assignees', 'due_date', 'url', 'parent', 'tags'];
const PRIORITIES = { urgent: 1, high: 2, normal: 3, low: 4, none: null };

function integer(value, name, min, max) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) usage(`${name} must be an integer from ${min} to ${max}.`);
  return Number(value);
}

const isID = value => /^\d+$/.test(value);
const fold = value => String(value ?? '').toLowerCase();

function selector(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) usage(`${name} must be a name or ID without control characters.`);
  if (isID(value)) numericID(value, name);
}

export function parseCommand(command, argv) {
  if (command === 'task' && ['create', 'update', 'comment', 'move', 'close'].includes(argv[0])) {
    command += ` ${argv[0]}`;
    argv = argv.slice(1);
  }
  if (!Object.hasOwn(COMMANDS, command)) usage('Unknown command.');
  const spec = COMMANDS[command];
  const known = [...Object.keys(spec.flags), 'help'];
  const repeatable = new Set(command === 'task create' ? ['tag'] : command === 'task update' ? ['add-tag', 'remove-tag'] : []);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options: Object.fromEntries(known.map(key => [key, { type: BOOLEAN_FLAGS.has(key) ? 'boolean' : 'string', multiple: repeatable.has(key) }])) });
  } catch (error) {
    usage(error.message, `Valid flags for ${command}: ${known.map(key => `--${key}`).join(', ')}. Run \`clickup-axi ${command} --help\`.`);
  }
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name) && !repeatable.has(token.name)) usage(`--${token.name} was supplied more than once.`);
    seen.add(token.name);
  }
  const flags = parsed.values;
  const args = parsed.positionals;
  if (flags.help) return { command, flags, args };
  const arity = ['task', 'task update', 'task comment', 'task move', 'task close', 'comments', 'list', 'search', 'setup'].includes(command) ? 1 : 0;
  if (args.length !== arity) usage(`Expected ${arity} argument(s) for ${command}.`, `Run \`clickup-axi ${spec.usage}\`.`);
  for (const [key, values] of Object.entries(flags)) {
    for (const value of [values].flat()) {
      if (typeof value === 'string' && !value.trim() && key !== 'description') usage(`--${key} must not be empty.`);
    }
  }
  for (const key of ['workspace', 'list', 'space', 'folder', 'assignee', 'unassign']) {
    if (flags[key] !== undefined) selector(flags[key], `--${key}`);
  }
  if (['task', 'task update', 'task comment', 'task move', 'task close', 'comments'].includes(command)) taskID(args[0]);
  if (command === 'list') selector(args[0], 'List');
  if (flags.parent !== undefined) {
    taskID(flags.parent);
    if (fold(flags.parent) === 'none') usage('ClickUp cannot clear a parent through this API. Use ClickUp to promote a subtask.');
  }
  if (['folders', 'tags'].includes(command) && !flags.space) usage('--space is required.', 'Run `clickup-axi spaces` to find a Space.');
  if (command === 'lists' && !flags.space && !flags.folder) usage('Use --space or --folder.', 'Run `clickup-axi folders --space <id>` to find Folders.');
  for (const [label, value] of [['List', command === 'list' ? args[0] : flags.list], ['Folder', flags.folder]]) {
    if (value !== undefined && !isID(value) && !flags.space) usage(`${label} names require --space.`, 'Supply --space <name|id>, or use a numeric ID.');
  }
  if (command === 'task move' && !flags.list) usage('--list is required for a move; project defaults are not used.');
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
  for (const key of ['assignee', 'unassign']) {
    if (flags[key] !== undefined && isID(flags[key])) integer(flags[key], `--${key}`, 1, Number.MAX_SAFE_INTEGER);
  }
  if (flags.assignee && fold(flags.assignee) === fold(flags.unassign)) usage('Cannot add and remove the same assignee.');
  if (flags.description !== undefined && flags['append-description'] !== undefined) usage('Use --description or --append-description, not both.');
  for (const key of repeatable) {
    if (!flags[key]) continue;
    if (flags[key].some(tag => /[\x00-\x1f\x7f]/.test(tag) || ['.', '..'].includes(tag))) usage(`--${key} contains an invalid tag name.`);
    flags[key] = [...new Map(flags[key].map(tag => [fold(tag), tag])).values()];
  }
  if (flags['add-tag']?.some(tag => flags['remove-tag']?.some(other => fold(tag) === fold(other)))) usage('Cannot add and remove the same tag.');
  if (flags.priority !== undefined && !Object.hasOwn(PRIORITIES, flags.priority)) usage('--priority must be urgent, high, normal, low, or none.');
  if (flags.due !== undefined && flags.due !== 'none') {
    const date = new Date(`${flags.due}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.due) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== flags.due) usage('--due must be a real YYYY-MM-DD date or none.');
  }
  if (command === 'task update' && !['name', 'description', 'append-description', 'status', 'priority', 'due', 'assignee', 'unassign', 'parent', 'add-tag', 'remove-tag'].some(key => flags[key] !== undefined)) usage('Supply at least one task field to update.', 'Run `clickup-axi task update --help`.');
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
    tags: (task.tags ?? []).map(tag => tag.name).join(', '),
  };
  return Object.fromEntries(fields.map(field => [field, row[field]]));
}

function collection(key, rows, help = []) {
  return { count: rows.length, totalCount: rows.length, ...(rows.length ? {} : { message: `0 ${key} found.` }), [key]: rows, ...(help.length ? { help } : {}) };
}

function scopeFlags(flags) {
  return `${flags.custom ? ' --custom' : ''}${flags.workspace ? ` --workspace ${shellQuote(flags.workspace)}` : ''}`;
}

function named(value, rows, kind, partial = true) {
  if (rows.some(row => !row || typeof row.name !== 'string')) throw new AxiError(`ClickUp returned invalid ${kind} names.`, 'API_RESPONSE');
  let matches = rows.filter(row => fold(row.name) === fold(value) || (row.email && fold(row.email) === fold(value)));
  if (!matches.length && partial) matches = rows.filter(row => fold(row.name).includes(fold(value)));
  if (matches.length === 1) return matches[0];
  const candidates = matches.length ? matches : rows;
  const shown = candidates.slice(0, 20).map(row => `${row.id ?? ''} ${JSON.stringify(row.name)}${row.folder ? ` (Folder: ${JSON.stringify(row.folder)})` : ''}`.trim());
  throw new AxiError(`${kind} ${JSON.stringify(value)} ${matches.length ? 'is ambiguous' : 'was not found'}.`, matches.length ? 'AMBIGUOUS_NAME' : 'NAME_NOT_FOUND', [
    `Use an exact name or ID. Candidates: ${shown.join(', ') || 'none'}${candidates.length > shown.length ? ` (${candidates.length - shown.length} more; use a discovery command)` : ''}.`,
  ]);
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
  let api;
  let userPromise;
  let teamsPromise;
  const user = () => userPromise ??= api('GET', 'user').then(data => {
    if (!data.user?.id) throw new AxiError('ClickUp returned an invalid user.', 'API_RESPONSE');
    return data.user;
  });
  const teams = () => teamsPromise ??= api('GET', 'team').then(data => requireArray(data, 'teams'));
  const defaults = () => readDefaults(env, cwd);

  async function workspace(selected) {
    if (selected && isID(selected)) return numericID(selected, 'Workspace ID');
    const rows = await teams();
    if (selected) return numericID(String(named(selected, rows, 'Workspace').id), 'Workspace ID');
    if (rows.length !== 1) throw new AxiError(`Select a workspace; ${rows.length} are available.`, 'WORKSPACE_REQUIRED', ['Run `clickup-axi workspaces`, then use --workspace <name|id> or set CLICKUP_WORKSPACE_ID.']);
    return numericID(String(rows[0].id), 'Workspace ID');
  }

  async function spaceID(flags) {
    if (!flags.space) usage('--space is required.');
    const selected = flags.workspace ?? defaults().workspace;
    if (!isID(flags.space) || selected) {
      flags.workspace = await workspace(selected);
      const rows = requireArray(await api('GET', `team/${flags.workspace}/space`, { archived: false }), 'spaces');
      const space = isID(flags.space) ? rows.find(space => String(space.id) === flags.space) : named(flags.space, rows, 'Space');
      if (!space) usage('The Space is not in the selected workspace.');
      flags.space = String(space.id);
    }
    return numericID(flags.space, 'Space ID');
  }

  async function folderID(flags) {
    if (!isID(flags.folder)) {
      const rows = requireArray(await api('GET', `space/${await spaceID(flags)}/folder`, { archived: false }), 'folders');
      flags.folder = String(named(flags.folder, rows, 'Folder').id);
    } else if (flags.space) {
      const space = await spaceID(flags);
      const folder = await api('GET', `folder/${flags.folder}`);
      if (String(folder.space?.id) !== space) usage('The Folder is not in the selected Space.');
    }
    return numericID(flags.folder, 'Folder ID');
  }

  async function listID(value, flags) {
    if (isID(value)) {
      if (flags.space) {
        const space = await spaceID(flags);
        const list = await api('GET', `list/${value}`);
        if (String(list.space?.id) !== space) usage('The List is not in the selected Space.');
      }
      return numericID(value, 'List ID');
    }
    const space = await spaceID(flags);
    const lists = requireArray(await api('GET', `space/${space}/list`, { archived: false }), 'lists').map(list => ({ ...list, folder: '(folderless)' }));
    const folders = requireArray(await api('GET', `space/${space}/folder`, { archived: false }), 'folders');
    for (const folder of folders) {
      const rows = requireArray(await api('GET', `folder/${numericID(String(folder.id), 'Folder ID')}/list`, { archived: false }), 'lists');
      lists.push(...rows.map(list => ({ ...list, folder: folder.name })));
    }
    return numericID(String(named(value, lists, 'List').id), 'List ID');
  }

  async function assigneeID(value, flags) {
    if (value === undefined) return undefined;
    if (isID(value)) return String(integer(value, 'User ID', 1, Number.MAX_SAFE_INTEGER));
    if (fold(value) === 'me') return String(integer(String((await user()).id), 'User ID', 1, Number.MAX_SAFE_INTEGER));
    flags.workspace = await workspace(flags.workspace ?? defaults().workspace);
    const team = (await teams()).find(team => String(team.id) === flags.workspace);
    if (!team) throw new AxiError('Workspace is not authorized.', 'WORKSPACE_REQUIRED', ['Run `clickup-axi workspaces`.']);
    const members = requireArray(team, 'members').map(({ user }) => ({ id: user?.id, name: user?.username ?? user?.email, email: user?.email }));
    return String(integer(String(named(value, members, 'Assignee').id), 'User ID', 1, Number.MAX_SAFE_INTEGER));
  }

  async function taskQuery(flags, id) {
    if (!flags.custom && !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(id)) return {};
    flags.workspace = await workspace(flags.workspace ?? defaults().workspace);
    return { custom_task_ids: true, team_id: flags.workspace };
  }

  async function taskList(flags, words) {
    const config = defaults();
    flags.list ??= config.list;
    flags.assignee ??= 'me';
    flags.workspace ??= config.workspace;
    if (flags.list) flags.list = await listID(flags.list, flags);
    else if (flags.space) await spaceID(flags);
    // A List-only query needs no workspace lookup. An explicit workspace must still constrain the query.
    const listOnly = flags.list && !flags.workspace && !flags.space;
    if (!listOnly) flags.workspace = await workspace(flags.workspace);
    const assignee = flags.assignee === 'all' ? 'all' : await assigneeID(flags.assignee, { ...flags });
    const path = listOnly ? `list/${flags.list}/task` : `team/${flags.workspace}/task`;
    const query = {
      subtasks: true, include_closed: flags['include-closed'] ?? false, order_by: 'updated', reverse: false,
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
    const data = await api('GET', `task/${id}/comment`, { ...(query ?? await taskQuery(flags, id)), start: flags.start, start_id: flags['start-id'] });
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

  async function parentID(value, list, current, flags) {
    const query = await taskQuery({ workspace: flags.workspace }, value);
    const parent = requireTask(await api('GET', `task/${value}`, query));
    if (String(parent.list?.id) !== list) usage('The parent must be in the same home List.');
    const seen = new Set(current ? [current] : []);
    let ancestor = parent;
    while (true) {
      if (seen.has(ancestor.id)) usage('The parent would create a task cycle.');
      seen.add(ancestor.id);
      if (!ancestor.parent) break;
      ancestor = requireTask(await api('GET', `task/${taskID(ancestor.parent)}`));
    }
    return taskID(parent.id);
  }

  async function spaceTags(space) {
    return requireArray(await api('GET', `space/${numericID(String(space), 'Space ID')}/tag`), 'tags');
  }

  async function moveTask(current, flags) {
    const targetID = await listID(flags.list, flags);
    const from = { id: numericID(String(current.list?.id), 'Home List ID'), name: current.list?.name };
    if (from.id === targetID) {
      if (flags.status && fold(flags.status) !== fold(current.status?.status)) usage('The task is already in this List. Use task update to change its status.');
      return { ...(flags['dry-run'] ? { dryRun: true } : {}), action: 'unchanged', changed: false, task: current.id, from, to: from };
    }
    const target = await api('GET', `list/${targetID}`);
    const statuses = requireArray(target, 'statuses').map(status => ({ ...status, name: status.status }));
    const kept = statuses.some(status => fold(status.name) === fold(current.status?.status));
    const body = {};
    let status = current.status?.status;
    if (kept) {
      if (flags.status && fold(flags.status) !== fold(status)) usage('The destination already has the current status. Move first, then use task update to change status.');
    } else {
      if (!flags.status) usage('The destination lacks the current status. Supply --status; no automatic remap is made.', `Destination statuses: ${statuses.map(status => JSON.stringify(status.name)).join(', ')}.`);
      const landing = named(flags.status, statuses, 'Status', false);
      if (!current.status?.id || !landing.id) throw new AxiError('ClickUp did not return the status IDs needed for a move.', 'API_RESPONSE');
      body.status_mappings = [{ source_status: current.status.id, destination_status: landing.id }];
      status = landing.name;
    }
    flags.workspace = await workspace(flags.workspace ?? defaults().workspace ?? current.team_id);
    const path = `workspaces/${flags.workspace}/tasks/${taskID(current.id)}/home_list/${targetID}`;
    const result = { changed: true, task: { id: current.id, name: current.name }, from, to: { id: targetID, name: target.name }, status };
    if (flags['dry-run']) return { dryRun: true, ...result, method: 'PUT', path: `/api/v3/${path}`, body };
    await api('PUT', path, {}, body, 'v3');
    return { action: 'moved', ...result };
  }

  async function taskWrite(command, id, flags) {
    const creating = command === 'task create';
    if (creating) {
      const config = defaults();
      flags.list ??= config.list;
      flags.workspace ??= config.workspace;
      if (!flags.list) usage('--list is required, or set a project default.', 'Run `clickup-axi lists --space <id>` to find a List.');
      if (flags.workspace) flags.workspace = await workspace(flags.workspace);
      flags.list = await listID(flags.list, flags);
      if (flags.workspace && !flags.space) {
        const list = await api('GET', `list/${flags.list}`);
        await spaceID({ workspace: flags.workspace, space: numericID(String(list.space?.id), 'Space ID') });
      }
    }
    const query = creating ? {} : await taskQuery(flags, id);
    if (command === 'task comment') {
      const body = { comment_text: flags.text, notify_all: flags.notify ?? false };
      if (flags['dry-run']) return { dryRun: true, task: id, body };
      const data = await api('POST', `task/${id}/comment`, query, body);
      if (!data.id) throw new AxiError('ClickUp did not return a comment ID. The comment may exist.', 'API_RESPONSE', ['Read `clickup-axi comments <id>` before retrying.']);
      return { action: 'commented', task: id, comment: { id: String(data.id) }, help: [`Run \`clickup-axi comments <id>${scopeFlags(flags)}\` to read comments.`] };
    }
    const current = creating ? null : requireTask(await api('GET', `task/${id}`, { ...query, include_markdown_description: flags['append-description'] ? true : undefined }));
    if (current?.team_id) {
      flags.workspace = await workspace(flags.workspace ?? defaults().workspace ?? String(current.team_id));
      if (flags.workspace !== String(current.team_id)) usage('The task is not in the selected workspace.');
    }
    if (command === 'task move') return moveTask(current, flags);
    const body = {};
    for (const key of ['name', 'description', 'status']) if (flags[key] !== undefined) body[key] = flags[key];
    const list = creating ? flags.list : numericID(String(current.list?.id), 'Home List ID');
    if (command === 'task close') {
      flags['dry-run'] ||= !flags.yes;
      if (fold(current.status?.type) !== 'closed') {
        const closed = requireArray(await api('GET', `list/${list}`), 'statuses').filter(status => fold(status.type) === 'closed');
        if (closed.length !== 1 || !closed[0].status) throw new AxiError('The List must have exactly one closed-type status.', 'API_RESPONSE', ['Read `clickup-axi list <id>` and use task update --status to select a status explicitly.']);
        body.status = closed[0].status;
      }
    } else if (body.status !== undefined) {
      if (!creating && fold(body.status) === fold(current.status?.status)) delete body.status;
      else {
        const statuses = requireArray(await api('GET', `list/${list}`), 'statuses').map(status => ({ ...status, name: status.status }));
        body.status = named(body.status, statuses, 'Status', false).name;
      }
    }
    if (flags.parent !== undefined) body.parent = await parentID(flags.parent, list, current?.id, flags);
    if (flags['append-description'] !== undefined) {
      if (typeof current.markdown_description !== 'string') throw new AxiError('ClickUp did not return the Markdown source. The description was not changed.', 'API_RESPONSE');
      body.markdown_content = [current.markdown_description, flags['append-description']].filter(Boolean).join('\n\n');
    }
    if (flags.priority !== undefined) body.priority = PRIORITIES[flags.priority];
    if (flags.due !== undefined) {
      body.due_date = flags.due === 'none' ? null : new Date(`${flags.due}T00:00:00.000Z`).getTime();
      // Untimed ClickUp dates shift to 4am in the creator's timezone. Use an explicit UTC instant.
      body.due_date_time = flags.due !== 'none';
    }
    const assignee = await assigneeID(flags.assignee, flags);
    const unassign = await assigneeID(flags.unassign, flags);
    if (assignee && assignee === unassign) usage('Cannot add and remove the same assignee.');
    const onTask = current && (flags['add-tag'] || flags['remove-tag']) ? requireArray(current, 'tags') : [];
    let addTags = (creating ? flags.tag : flags['add-tag']) ?? [];
    addTags = addTags.filter(tag => !onTask.some(other => fold(other.name) === fold(tag)));
    if (addTags.length) {
      const space = current?.space?.id ?? (await api('GET', `list/${list}`)).space?.id;
      const tags = await spaceTags(space);
      addTags = addTags.map(tag => named(tag, tags, 'Tag', false).name);
    }
    const removeTags = onTask.filter(tag => flags['remove-tag']?.some(other => fold(other) === fold(tag.name))).map(tag => tag.name);
    if (creating) {
      if (assignee) body.assignees = [Number(assignee)];
      if (addTags.length) body.tags = addTags;
      if (flags['dry-run']) return { dryRun: true, list, body };
      const task = requireTask(await api('POST', `list/${list}/task`, {}, body));
      return { action: 'created', task: taskRow(task, FIELDS), help: ['Run `clickup-axi task <id>` for details.'] };
    }
    const description = current.description ?? current.text_content ?? '';
    const existing = { name: current.name, description: description.trim() ? description : '', parent: current.parent, status: current.status?.status, priority: current.priority ? Number(current.priority.id) : null, due_date: current.due_date == null ? null : Number(current.due_date) };
    if (body.due_date === existing.due_date) {
      delete body.due_date;
      delete body.due_date_time;
    }
    for (const key of ['name', 'description', 'parent', 'status', 'priority']) if (body[key] === existing[key]) delete body[key];
    const assigned = new Set((current.assignees ?? []).map(person => String(person.id)));
    const add = assignee && !assigned.has(assignee) ? [Number(assignee)] : [];
    const rem = unassign && assigned.has(unassign) ? [Number(unassign)] : [];
    if (add.length || rem.length) body.assignees = { add, rem };
    // ClickUp documents a single space, not an empty string, as the clear-description payload.
    if (body.description === '') body.description = ' ';
    const requests = [
      ...addTags.map(tag => ({ method: 'POST', path: `task/${taskID(current.id)}/tag/${encodeURIComponent(tag)}`, body: {} })),
      ...removeTags.map(tag => ({ method: 'DELETE', path: `task/${taskID(current.id)}/tag/${encodeURIComponent(tag)}`, body: {} })),
    ];
    if (Object.keys(body).length) requests.push({ method: 'PUT', path: `task/${id}`, query, body });
    const changed = requests.length > 0;
    const help = [`Run \`clickup-axi task ${shellQuote(id)}${scopeFlags(flags)}\` for details.`];
    if (command === 'task close' && changed) help.push(`Closing hides the task from default listings. Run \`clickup-axi task close ${shellQuote(id)}${scopeFlags(flags)} --yes\` only after user approval.`);
    if (flags['dry-run']) return { dryRun: true, task: { id: current.id, name: current.name }, changed, body, requests, help };
    let updated = current;
    let completed = 0;
    // Tag endpoints and field updates are separate writes. Do not invent rollback guarantees after an uncertain response.
    try {
      for (const request of requests) {
        const data = await api(request.method, request.path, request.query, request.body);
        if (request.method === 'PUT') updated = requireTask(data);
        completed++;
      }
    } catch (error) {
      if (requests.length === 1) throw error;
      throw new AxiError(`Task edit stopped after ${completed} of ${requests.length} writes were confirmed. The failed write may also have succeeded.`, 'PARTIAL_WRITE', [
        `${error.code}: ${error.message}`, ...help, 'Read the task before retrying. No rollback or automatic retry was attempted.',
      ]);
    }
    if (updated === current && (addTags.length || removeTags.length)) updated = { ...current, tags: [...onTask.filter(tag => !removeTags.includes(tag.name)), ...addTags.map(name => ({ name }))] };
    return { action: changed ? command === 'task close' ? 'closed' : 'updated' : 'unchanged', changed, task: taskRow(updated, FIELDS), help: help.slice(0, 1) };
  }

  async function dispatch(command, argv) {
    const parsed = parseCommand(command, argv);
    command = parsed.command;
    const { flags, args } = parsed;
    if (flags.help) return commandHelp(command);
    let id = args[0];
    if (command === 'setup') return setupHooks(id, { cwd, homeDir, execPath, global: flags.global });
    if (command === 'update') return { message: 'This is a local package; no update was installed.', help: ['In your checkout, run `npm install --ignore-scripts` and `npm install -g .`.'] };
    if (command === 'home') {
      const config = defaults();
      const selected = { workspace: flags.workspace ?? config.workspace, list: flags.list ?? config.list, space: flags.space, limit: 5, page: 0 };
      if (selected.workspace || selected.list || selected.space) {
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
    if (command === 'tags') return { space: await spaceID(flags), ...collection('tags', await spaceTags(flags.space)) };
    if (command === 'folders' || command === 'lists') {
      if (flags.folder) await folderID(flags);
      else await spaceID(flags);
      const path = command === 'folders' ? `space/${flags.space}/folder` : flags.folder ? `folder/${flags.folder}/list` : `space/${flags.space}/list`;
      const key = command;
      const data = await api('GET', path, { archived: false });
      return { scope: flags.folder ? { folder: flags.folder } : { space: flags.space, ...(key === 'lists' ? { folderless: true } : {}) }, ...collection(key, requireArray(data, key).map(item => ({ id: String(item.id), name: item.name, ...(key === 'lists' ? { taskCount: item.task_count == null ? null : Number(item.task_count) } : {}) })), key === 'folders' ? ['Run `clickup-axi lists --folder <id>` for Lists in a Folder.'] : ['Run `clickup-axi list <id>` for allowed statuses.', 'Run `clickup-axi tasks --list <id>` for your open tasks.']) };
    }
    if (command === 'list') {
      id = await listID(id, flags);
      const data = await api('GET', `list/${id}`);
      const body = preview(data.content, flags);
      return { list: { id: String(data.id), name: data.name, taskCount: data.task_count == null ? null : Number(data.task_count), description: body.text }, statuses: requireArray(data, 'statuses').map(status => ({ name: status.status, type: status.type })), help: ['Run `clickup-axi task create --list <id> --name "<name>"` to add a task.', ...(body.truncated ? ['Run `clickup-axi list <id> --full` for the full description.'] : [])] };
    }
    if (command === 'tasks' || command === 'search') return taskList(flags, command === 'search' ? id : undefined);
    if (command.startsWith('task ')) return taskWrite(command, id, flags);
    if (command === 'comments') return commentPage(id, flags);
    const query = await taskQuery(flags, id);
    const data = requireTask(await api('GET', `task/${id}`, query));
    const body = preview(data.description ?? data.text_content, flags);
    const comments = await commentPage(id, flags, 5, query);
    const help = [...(comments.help ?? [])];
    if (body.truncated) help.push(`Run \`clickup-axi task <id>${scopeFlags(flags)} --full\` for the full description.`);
    delete comments.help;
    return { task: { ...taskRow(data, FIELDS), list: data.list ? { id: String(data.list.id), name: data.list.name } : null, description: body.text }, comments, ...(help.length ? { help } : {}) };
  }
  async function execute(command, argv = []) {
    api = createClient({ env, cwd, fetchImpl, timeoutMs });
    userPromise = teamsPromise = undefined;
    return dispatch(command, argv);
  }
  return { execute };
}

export async function main(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  if (argv.length === 1 && argv[0] === '--help') return void stdout.write(TOP_LEVEL_HELP);
  if (argv.length === 1 && ['-v', '-V', '--version'].includes(argv[0])) return void stdout.write(`${VERSION}\n`);
  try {
    const command = argv[0] ?? 'home';
    if (command.startsWith('-')) usage('Flags must come after the command.');
    if (command.includes(' ')) usage('Unknown command.');
    const result = await createApp(options).execute(command, argv.slice(1));
    const data = argv.length ? result : { bin: options.execPath ?? ENTRY, description: DESCRIPTION, ...result };
    stdout.write(`${renderOutput(data)}\n`);
  } catch (error) {
    const known = error instanceof AxiError;
    stdout.write(`${renderOutput({ error: known ? error.message : 'The command failed.', code: known ? error.code : 'INTERNAL_ERROR', help: known ? error.suggestions : ['Run the command again. After a failed write, read the task state before retrying.'] })}\n`);
    process.exitCode = known && error.code === 'VALIDATION_ERROR' ? 2 : 1;
  }
}
