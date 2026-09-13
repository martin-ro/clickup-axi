import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp, main } from '../skills/clickup-axi/scripts/cli.mjs';
import { COMMANDS } from '../skills/clickup-axi/scripts/help.mjs';
import { createClient, projectConfig, readToken } from '../skills/clickup-axi/scripts/api.mjs';
import { invocation, ENTRY } from '../skills/clickup-axi/scripts/invocation.mjs';
import { VERSION } from '../skills/clickup-axi/scripts/version.mjs';

const TOKEN = 'pk_test_secret';
const task = (id = 'abc123', extra = {}) => ({
  id, name: 'Fix login', status: { id: 'open-id', status: 'open', type: 'open' }, description: 'Check redirects',
  list: { id: '200', name: 'Sprint' }, space: { id: '300' }, parent: null, tags: [], priority: null, due_date: null, assignees: [], ...extra,
});
const list = (id = '200', extra = {}) => ({ id, name: 'Sprint', space: { id: '300' }, statuses: [
  { id: 'open-id', status: 'open', type: 'open' }, { id: 'done-id', status: 'done', type: 'done' }, { id: 'closed-id', status: 'closed', type: 'closed' },
], ...extra });
const comment = n => ({ id: String(n), date: String(1700000000000 + n), user: { username: 'Alice' }, comment_text: `Note ${n}` });

function fixture(t, handler = () => assert.fail('Unexpected API call'), options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'clickup-axi-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.git'));
  const calls = [];
  const config = { cwd, homeDir: join(cwd, 'home'), env: { CLICKUP_API_TOKEN: TOKEN }, ...options,
    fetchImpl: async (url, init) => {
      assert.equal(url.origin, 'https://api.clickup.com');
      assert.equal(init.headers.Authorization, TOKEN);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      const call = { version: url.pathname.split('/')[2], path: url.pathname.replace(/^\/api\/v[23]\//, ''), query: Object.fromEntries(url.searchParams), method: init.method, body: init.body && JSON.parse(init.body) };
      calls.push(call);
      const data = await handler(call);
      return data instanceof Response ? data : Response.json(data);
    },
  };
  return { ...createApp(config), cwd, calls, config };
}

async function output(argv, options = {}) {
  let text = '';
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await main(argv, { ...options, stdout: { write: value => { text += value; } } });
    return { text, code: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

function basics(call) {
  if (call.path === 'team') return { teams: [{ id: '100', name: 'Work', members: [{ user: { id: 7, username: 'Alice', email: 'a@example.test' } }] }] };
  if (call.path === 'user') return { user: { id: 7, username: 'Alice' } };
  if (call.path.endsWith('/task')) return { tasks: [task()] };
  assert.fail(`Unexpected API call ${call.path}`);
}

test('strict input validation happens before all API calls', async t => {
  const app = fixture(t);
  const invalid = [
    ['tasks', ['--stat', 'closed']], ['tasks', ['unexpected']], ['tasks', ['--limit', '0']],
    ['tasks', ['--limit', '1.5']], ['tasks', ['--page', '-1']], ['tasks', ['--list', '../1']],
    ['tasks', ['--workspace', '1', '--workspace', '2']], ['tasks', ['--fields', 'id,password']],
    ['tasks', ['--fields', 'id,id']], ['task', ['create', '--list', '2']],
    ['task', ['create', '--name', 'x', '--status', '']], ['task', ['update', 'abc123']],
    ['task', ['update', 'abc123', '--due', '2025-02-29']], ['task', ['update', 'abc123', '--priority', 'highest']],
    ['task', ['update', 'abc123', '--assignee', '7', '--unassign', '7']],
    ['task', ['comment', 'abc123']], ['task', ['abc123', '--status', 'open']],
    ['task', ['../abc123']], ['folders', []], ['lists', ['--folder', 'Sprints']],
    ['tags', []], ['list', ['Sprint']], ['task', ['move', 'abc123']], ['task', ['close']],
    ['task', ['update', 'abc123', '--parent', 'none']],
    ['task', ['update', 'abc123', '--description', 'x', '--append-description', 'y']],
    ['task', ['update', 'abc123', '--add-tag', 'bug', '--remove-tag', 'BUG']],
    ['task', ['create', '--list', '200', '--name', 'x', '--tag', '..']],
    ['task', ['update', 'abc123', '--add-tag', 'x\ny']],
    ['tasks', ['--workspace', 'Work\n']], ['task', ['create', '--list', 'Sprint', '--name', 'x']],
    ['comments', ['abc123', '--start', '123']], ['comments', ['abc123', '--start-id', '1']],
    ['search', ['   ']], ['setup', ['login']], ['workspaces', ['--workspace', '1']],
  ];
  for (const [command, args] of invalid) {
    await assert.rejects(app.execute(command, args), { code: 'VALIDATION_ERROR' }, `${command} ${args.join(' ')}`);
  }
  assert.equal(app.calls.length, 0);
});

test('help for every command works without auth, config, or API calls', async t => {
  const app = fixture(t, undefined, { env: {} });
  writeFileSync(join(app.cwd, '.clickup-axi.json'), 'invalid');
  mkdirSync(join(app.cwd, '.env'));
  for (const command of Object.keys(COMMANDS)) {
    const [root, ...args] = command.split(' ');
    const data = await app.execute(root, [...args, '--help']);
    assert.ok(data.command.startsWith(invocation(ENTRY, app.config).command + ' '));
    assert.ok(data.flags['--help']);
  }
  assert.equal(app.calls.length, 0);
  assert.equal(existsSync(join(app.cwd, '.claude')), false);
});

test('entrypoint version aliases and help run without credentials', () => {
  for (const flag of ['-v', '-V', '--version', '--help']) {
    const result = spawnSync(process.execPath, ['bin/clickup-axi.js', flag], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (flag !== '--help') assert.equal(result.stdout, `${VERSION}\n`);
  }
});

test('CLI boundary returns structured usage errors, including prototype names', async t => {
  const app = fixture(t);
  for (const args of [['tasks', '--invented'], ['missing-command'], ['__proto__'], ['constructor'], ['--workspace', '100']]) {
    const result = await output(args, app.config);
    assert.equal(result.code, 2);
    assert.match(result.text, /error:/);
    assert.match(result.text, /help/);
  }
  assert.equal(app.calls.length, 0);
});

test('home is live content, with no implicit hook installation', async t => {
  const app = fixture(t, basics);
  const result = await output([], app.config);
  assert.equal(result.code, 0);
  assert.match(result.text, /bin: /);
  assert.match(result.text, /description: Browse ClickUp/);
  assert.match(result.text, /workspaces\[1\]\{id,name\}/);
  assert.equal(existsSync(join(app.cwd, '.claude')), false);
  assert.deepEqual(app.calls.map(call => call.path), ['team']);
});

test('project defaults are discovered from child directories and stop at Git boundaries', async t => {
  const app = fixture(t, basics);
  writeFileSync(join(app.cwd, '.clickup-axi.json'), JSON.stringify({ workspace: '100', list: '200' }));
  mkdirSync(join(app.cwd, 'src'));
  assert.equal(projectConfig(join(app.cwd, 'src')).list, '200');
  mkdirSync(join(app.cwd, 'src', '.git'));
  assert.deepEqual(projectConfig(join(app.cwd, 'src')), {});
  const result = await app.execute('tasks', ['--list', '300', '--workspace', '400']);
  assert.equal(result.scope.list, '300');
  assert.equal(result.scope.workspace, '400');
  assert.equal(app.calls.at(-1).path, 'team/400/task');
  assert.equal(app.calls.at(-1).query['list_ids[]'], '300');
});

test('environment defaults beat project defaults and home preserves truncation hints', async t => {
  const app = fixture(t, call => call.path === 'user' ? basics(call) : { tasks: Array.from({ length: 8 }, (_, i) => task(`t${i}`)) }, { env: { CLICKUP_API_TOKEN: TOKEN, CLICKUP_WORKSPACE_ID: '101' } });
  writeFileSync(join(app.cwd, '.clickup-axi.json'), JSON.stringify({ workspace: '100', list: '200' }));
  const result = await app.execute('home');
  assert.equal(result.count, 5);
  assert.equal(result.totalCount, 8);
  assert.equal(result.scope.workspace, '101');
  assert.ok(result.help.some(hint => hint.includes('--limit 100') && hint.includes('--list 200') && hint.includes('--workspace 101')));
});

test('bad project config fails instead of changing scope silently', async t => {
  const app = fixture(t);
  for (const data of ['no JSON', 'null', '{"token":"secret"}', '{"list":200}', '{"list":""}']) {
    writeFileSync(join(app.cwd, '.clickup-axi.json'), data);
    await assert.rejects(app.execute('tasks'));
  }
  assert.equal(app.calls.length, 0);
});

test('workspace ambiguity fails without selecting the first workspace', async t => {
  const app = fixture(t, () => ({ teams: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] }));
  await assert.rejects(app.execute('tasks'), { code: 'WORKSPACE_REQUIRED' });
  assert.equal(app.calls.length, 1);
});

test('hierarchy discovery includes members, Folders, folderless Lists, and statuses', async t => {
  const app = fixture(t, call => {
    const responses = {
      'team/100/space': { spaces: [{ id: '300', name: 'Dev', private: true }] },
      'space/300/folder': { folders: [{ id: '400', name: 'Sprints' }] },
      'space/300/list': { lists: [] },
      'folder/400/list': { lists: [{ id: '200', name: 'Sprint', task_count: '8' }] },
      'list/200': { id: '200', name: 'Sprint', content: 'Long text', task_count: '8', statuses: [{ status: 'open', type: 'open' }] },
    };
    return responses[call.path] ?? basics(call);
  });
  assert.equal((await app.execute('workspaces')).totalCount, 1);
  assert.equal((await app.execute('members')).members[0].id, '7');
  assert.equal((await app.execute('spaces')).spaces[0].private, true);
  assert.equal((await app.execute('folders', ['--space', '300'])).folders[0].id, '400');
  assert.equal((await app.execute('lists', ['--space', '300'])).scope.folderless, true);
  assert.equal((await app.execute('lists', ['--folder', '400'])).lists[0].taskCount, 8);
  const list = await app.execute('list', ['200', '--max-chars', '2']);
  assert.equal(list.statuses[0].name, 'open');
  assert.match(list.list.description, /truncated/);
});

test('tasks are scoped to me, include subtasks, and use exact API array parameters', async t => {
  const app = fixture(t, basics);
  const result = await app.execute('tasks', ['--status', 'in review', '--tag', 'a,b']);
  assert.equal(result.totalCount, 1);
  assert.deepEqual(Object.keys(result.tasks[0]), ['id', 'name', 'status', 'list']);
  assert.deepEqual(app.calls.at(-1).query, { subtasks: 'true', include_closed: 'false', order_by: 'updated', reverse: 'false', 'assignees[]': '7', 'statuses[]': 'in review', 'tags[]': 'a,b', page: '0' });
});

test('List-only reads include Tasks in Multiple Lists and avoid workspace lookup', async t => {
  const app = fixture(t, basics);
  const result = await app.execute('tasks', ['--list', '200', '--assignee', 'all', '--fields', 'id,priority,url']);
  assert.equal(result.scope.workspace, undefined);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].path, 'list/200/task');
  assert.equal(app.calls[0].query.include_timl, 'true');
  assert.equal(app.calls[0].query['assignees[]'], undefined);
  assert.deepEqual(Object.keys(result.tasks[0]), ['id', 'priority', 'url']);
});

test('task pages never present page size as a global total, and preserve filter hints', async t => {
  const app = fixture(t, () => ({ tasks: Array.from({ length: 100 }, (_, i) => task(`t${i}`)) }));
  const result = await app.execute('tasks', ['--workspace', '100', '--assignee', 'all', '--status', "Bob's queue", '--include-closed', '--limit', '2']);
  assert.equal(result.count, 2);
  assert.equal(result.totalCount, null);
  assert.equal(result.scanned, undefined);
  assert.equal(result.page, 0);
  assert.equal(result.nextPage, 1);
  assert.ok(result.help.some(hint => hint.includes('--page 1') && hint.includes('--workspace 100') && hint.includes('--include-closed') && hint.includes("'Bob'\\''s queue'")));
});

test('empty later pages have an unknown global total and an explicit empty state', async t => {
  const app = fixture(t, () => ({ tasks: [] }));
  const result = await app.execute('tasks', ['--workspace', '100', '--assignee', 'all', '--page', '2']);
  assert.equal(result.count, 0);
  assert.equal(result.totalCount, null);
  assert.equal(result.hasMore, false);
  assert.match(result.message, /^0 tasks/);
});

test('search scans multiple pages and exposes every match with offset pagination', async t => {
  const app = fixture(t, call => ({ tasks: Array.from({ length: call.query.page === '0' ? 100 : 21 }, (_, i) => task(`t${call.query.page}-${i}`, { name: 'OAuth login', description: 'Check callback' })) }));
  const flags = ['OAuth callback', '--workspace', '100', '--assignee', 'all'];
  const first = await app.execute('search', flags);
  assert.equal(first.scanned, 121);
  assert.equal(first.totalCount, 121);
  assert.equal(first.count, 100);
  assert.equal(first.nextOffset, 100);
  const second = await app.execute('search', [...flags, '--offset', '100']);
  assert.equal(second.count, 21);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.tasks, ...second.tasks].map(item => item.id)).size, 121);
});

test('bounded search reports an incomplete scan and retains the next page', async t => {
  const app = fixture(t, () => ({ tasks: Array.from({ length: 100 }, (_, i) => task(`t${i}`)) }));
  const result = await app.execute('search', ['absent', '--workspace', '100', '--assignee', 'all', '--pages', '2']);
  assert.equal(app.calls.length, 2);
  assert.equal(result.totalCount, null);
  assert.equal(result.count, 0);
  assert.equal(result.nextPage, 2);
  assert.match(result.message, /Unscanned pages/);
});

test('task detail includes comments, Unicode-safe previews, and custom ID context', async t => {
  const app = fixture(t, call => call.path.endsWith('/comment')
    ? { comments: Array.from({ length: 25 }, (_, i) => comment(100 - i)) }
    : task('abc123', { description: '😀😀😀 body', custom_id: 'PROJ-1' }));
  const result = await app.execute('task', ['PROJ-1', '--custom', '--workspace', '100', '--max-chars', '2']);
  assert.match(result.task.description, /^😀😀\.\.\./);
  assert.equal(result.comments.count, 5);
  assert.equal(result.comments.totalCount, null);
  assert.equal(result.comments.next.startId, '96');
  assert.ok(result.help.every(hint => hint.includes('--custom') && hint.includes('--workspace 100')));
  assert.ok(app.calls.every(call => call.query.custom_task_ids === 'true' && call.query.team_id === '100'));
  const full = await app.execute('task', ['abc123', '--full']);
  assert.equal(full.task.description, '😀😀😀 body');
});

test('comments carry both cursors and give exact totals only for the complete first page', async t => {
  const app = fixture(t, () => ({ comments: [] }));
  const first = await app.execute('comments', ['abc123']);
  assert.equal(first.totalCount, 0);
  assert.match(first.message, /^0 comments/);
  const later = await app.execute('comments', ['abc123', '--start', '1700000000001', '--start-id', '1']);
  assert.equal(later.totalCount, null);
  assert.deepEqual(app.calls.at(-1).query, { start: '1700000000001', start_id: '1' });
});

test('updates are idempotent and return the mutation response without a follow-up read', async t => {
  let current = task('abc123');
  const app = fixture(t, call => {
    if (call.path === 'list/200') return list();
    if (call.method === 'PUT') current = { ...current, status: { status: call.body.status } };
    return current;
  });
  const first = await app.execute('task', ['update', 'abc123', '--status', 'closed']);
  assert.equal(first.changed, true);
  assert.equal(first.task.status, 'closed');
  const second = await app.execute('task', ['update', 'abc123', '--status', 'closed']);
  assert.equal(second.action, 'unchanged');
  assert.deepEqual(app.calls.map(call => call.method), ['GET', 'GET', 'PUT', 'GET']);
});

test('updates map due dates, clear values, and add/remove assignees in one write', async t => {
  const app = fixture(t, call => call.method === 'GET' ? task('abc123', { assignees: [{ id: 7 }], priority: { id: '2', priority: 'high' }, due_date: '1', due_date_time: true }) : task());
  await app.execute('task', ['update', 'PROJ-1', '--custom', '--workspace', '100', '--due', '2024-02-29', '--priority', 'none', '--description', '', '--assignee', '8', '--unassign', '7']);
  assert.deepEqual(app.calls[1].body, { description: ' ', priority: null, due_date: Date.parse('2024-02-29T00:00:00.000Z'), due_date_time: true, assignees: { add: [8], rem: [7] } });
  assert.equal(app.calls[1].query.custom_task_ids, 'true');
  assert.equal(app.calls[1].query.team_id, '100');
});

test('clearing descriptions uses the API payload and remains idempotent', async t => {
  let current = task();
  const app = fixture(t, call => {
    if (call.method === 'PUT') current = { ...current, ...call.body };
    return current;
  });
  assert.equal((await app.execute('task', ['update', 'abc123', '--description', ''])).changed, true);
  assert.deepEqual(app.calls.at(-1).body, { description: ' ' });
  assert.equal((await app.execute('task', ['update', 'abc123', '--description', ''])).changed, false);
  assert.equal(app.calls.length, 3);
});

test('already matching dates, priority, and assignees produce no write', async t => {
  const app = fixture(t, () => task('abc123', { assignees: [{ id: 7 }], due_date: String(Date.parse('2024-02-29T00:00:00.000Z')) }));
  const result = await app.execute('task', ['update', 'abc123', '--name', 'Fix login', '--description', 'Check redirects', '--due', '2024-02-29', '--priority', 'none', '--assignee', '7', '--unassign', '8']);
  assert.equal(result.changed, false);
  assert.equal(app.calls.length, 1);
});

test('dry runs never write and creation validates a target List before any API call', async t => {
  const app = fixture(t, () => task(), { env: {} });
  const created = await app.execute('task', ['create', '--name', 'New', '--list', '200', '--assignee', '7', '--dry-run']);
  assert.deepEqual(created.body, { name: 'New', assignees: [7] });
  const commented = await app.execute('task', ['comment', 'abc123', '--text', 'Hello', '--dry-run']);
  assert.deepEqual(commented.body, { comment_text: 'Hello', notify_all: false });
  await assert.rejects(app.execute('task', ['create', '--name', 'New']), { code: 'VALIDATION_ERROR' });
  assert.equal(app.calls.length, 0);
  const normal = fixture(t, call => call.path === 'list/200' ? list() : task());
  assert.equal((await normal.execute('task', ['update', 'abc123', '--status', 'closed', '--dry-run'])).changed, true);
  assert.deepEqual(normal.calls.map(call => call.method), ['GET', 'GET']);
});

test('create and comment write once and do not send notifications unless requested', async t => {
  const app = fixture(t, call => call.path.endsWith('/comment') ? { id: '123' } : task());
  assert.equal((await app.execute('task', ['create', '--name', 'New', '--list', '200'])).action, 'created');
  assert.equal((await app.execute('task', ['comment', 'abc123', '--text', 'Hello'])).comment.id, '123');
  assert.deepEqual(app.calls.map(call => call.method), ['POST', 'POST']);
  assert.deepEqual(app.calls[1].body, { comment_text: 'Hello', notify_all: false });
});

function hierarchy(call) {
  const data = {
    'team/100/space': { spaces: [{ id: '300', name: 'Dev' }, { id: '301', name: 'Development' }] },
    'space/300/folder': { folders: [{ id: '400', name: 'Sprints' }] },
    'space/300/list': { lists: [{ id: '202', name: 'Inbox' }] },
    'folder/400/list': { lists: [list()] },
    'folder/400': { id: '400', space: { id: '300' } },
    'list/200': list(),
    'space/300/tag': { tags: [{ name: 'Bug' }, { name: 'a,b' }] },
  };
  return data[call.path] ?? basics(call);
}

test('names resolve through the hierarchy, with exact matches before unique substrings', async t => {
  const app = fixture(t, hierarchy);
  assert.equal((await app.execute('spaces', ['--workspace', 'wo'])).workspace, '100');
  assert.equal((await app.execute('folders', ['--space', 'dev', '--workspace', 'Work'])).scope.space, '300');
  assert.equal((await app.execute('lists', ['--folder', 'sprint', '--space', 'Dev'])).scope.folder, '400');
  assert.equal((await app.execute('list', ['Sprint', '--space', 'Dev'])).list.id, '200');
  assert.equal((await app.execute('tags', ['--space', 'Dev'])).tags[0].name, 'Bug');
  const result = await app.execute('tasks', ['--list', 'Sprint', '--space', 'Dev', '--assignee', 'a@example.test']);
  assert.equal(result.scope.list, '200');
  assert.equal(app.calls.at(-1).query['assignees[]'], '7');
  assert.equal(app.calls.at(-1).query['space_ids[]'], '300');
  assert.equal(app.calls.at(-1).query['list_ids[]'], '200');
  assert.ok(app.calls.every(call => call.method === 'GET'));
});

test('duplicate names fail with candidate IDs and Folder context, and partial inventories fail closed', async t => {
  const app = fixture(t, call => call.path === 'space/300/list' ? { lists: [{ id: '202', name: 'Sprint' }] } : hierarchy(call));
  await assert.rejects(app.execute('task', ['create', '--name', 'x', '--list', 'sprint', '--space', 'Dev']), error => {
    assert.equal(error.code, 'AMBIGUOUS_NAME');
    assert.match(error.suggestions[0], /202.*folderless.*200.*Sprints/);
    return true;
  });
  await assert.rejects(app.execute('folders', ['--space', 'de']), { code: 'AMBIGUOUS_NAME' });
  await assert.rejects(app.execute('list', ['absent', '--space', '300']), { code: 'NAME_NOT_FOUND' });
  const broken = fixture(t, call => call.path === 'folder/400/list' ? new Response('', { status: 403 }) : hierarchy(call));
  await assert.rejects(broken.execute('task', ['create', '--name', 'x', '--list', 'Inbox', '--space', '300']), { code: 'HTTP_403' });
  assert.ok([...app.calls, ...broken.calls].every(call => call.method === 'GET'));
});

test('explicit Space constraints also validate numeric Lists and Folders', async t => {
  const app = fixture(t, hierarchy);
  for (const [command, args] of [
    ['task', ['create', '--name', 'x', '--list', '200', '--space', '301']],
    ['tasks', ['--list', '200', '--space', '301']],
    ['lists', ['--folder', '400', '--space', '301']],
  ]) await assert.rejects(app.execute(command, args), { code: 'VALIDATION_ERROR' });
  assert.ok(app.calls.every(call => call.method === 'GET'));
});

test('assignee names, emails, and me work for writes and resolved conflicts make no write', async t => {
  const app = fixture(t, call => call.path === 'task/abc123' ? task() : hierarchy(call));
  const result = await app.execute('task', ['update', 'abc123', '--assignee', 'ali', '--dry-run']);
  assert.deepEqual(result.requests[0].body.assignees, { add: [7], rem: [] });
  const created = await app.execute('task', ['create', '--list', '200', '--name', 'x', '--assignee', 'me', '--dry-run']);
  assert.deepEqual(created.body.assignees, [7]);
  await assert.rejects(app.execute('task', ['update', 'abc123', '--assignee', 'Alice', '--unassign', 'a@example.test']), { code: 'VALIDATION_ERROR' });
  await assert.rejects(app.execute('task', ['update', 'abc123', '--assignee', 'unknown']), { code: 'NAME_NOT_FOUND' });
  assert.ok(app.calls.every(call => call.method === 'GET'));
  const ambiguous = fixture(t, call => call.path === 'team' ? { teams: [{ id: '100', name: 'Work', members: [
    { user: { id: 7, username: 'Alice' } }, { user: { id: 8, username: 'Alicia' } },
  ] }] } : hierarchy(call));
  await assert.rejects(ambiguous.execute('tasks', ['--assignee', 'ali']), { code: 'AMBIGUOUS_NAME' });
  await ambiguous.execute('tasks', ['--assignee', 'Alice']);
  assert.equal(ambiguous.calls.at(-1).query['assignees[]'], '7');
});

test('PREFIX-number custom IDs are detected on task and comment paths', async t => {
  const app = fixture(t, call => call.path === 'team' ? basics(call) : call.path.endsWith('/comment') ? { comments: [] } : task());
  await app.execute('task', ['PROJ-42']);
  await app.execute('comments', ['PROJ-42']);
  await app.execute('task', ['comment', 'PROJ-42', '--text', 'x', '--dry-run']);
  await app.execute('task', ['update', 'PROJ-42', '--name', 'New', '--dry-run']);
  assert.ok(app.calls.filter(call => call.path !== 'team').every(call => call.query.custom_task_ids === 'true' && call.query.team_id === '100'));
  assert.ok(app.calls.every(call => call.method === 'GET'));
});

test('create validates names, parent, status, and tags before one write', async t => {
  const app = fixture(t, call => call.path === 'task/PROJ-42' ? task('parent') : call.method === 'POST' ? task('new') : hierarchy(call));
  const args = ['create', '--name', 'x', '--list', 'Sprint', '--space', 'Dev', '--status', 'OPEN', '--parent', 'PROJ-42', '--assignee', 'Alice', '--tag', 'bug', '--tag', 'a,b', '--tag', 'BUG'];
  const dry = await app.execute('task', [...args, '--dry-run']);
  assert.deepEqual(dry.body, { name: 'x', status: 'open', parent: 'parent', assignees: [7], tags: ['Bug', 'a,b'] });
  assert.equal(app.calls.find(call => call.path === 'task/PROJ-42').query.custom_task_ids, 'true');
  assert.ok(app.calls.every(call => call.method === 'GET'));
  await app.execute('task', args);
  assert.equal(app.calls.filter(call => call.method !== 'GET').length, 1);
  assert.deepEqual(app.calls.at(-1).body, dry.body);
  assert.equal(app.calls.at(-1).path, 'list/200/task');
});

test('creation rejects missing, ambiguous, and mismatched workspace selections before any write', async t => {
  for (const lists of [['--list', '200'], ['--list', 'Sprint', '--space', '300']]) {
    const ambiguous = fixture(t, () => ({ teams: [{ id: '100', name: 'Work A' }, { id: '101', name: 'Work B' }] }));
    await assert.rejects(ambiguous.execute('task', ['create', '--name', 'x', '--workspace', 'Work', ...lists]), { code: 'AMBIGUOUS_NAME' });
    assert.deepEqual(ambiguous.calls.map(call => call.path), ['team']);
    const missing = fixture(t, hierarchy);
    await assert.rejects(missing.execute('task', ['create', '--name', 'x', '--workspace', 'Absent', ...lists]), { code: 'NAME_NOT_FOUND' });
    const mismatch = fixture(t, call => call.path === 'team/100/space' ? { spaces: [{ id: '301', name: 'Other' }] } : hierarchy(call));
    await assert.rejects(mismatch.execute('task', ['create', '--name', 'x', '--workspace', 'Work', ...lists]), { code: 'VALIDATION_ERROR' });
    assert.ok([...missing.calls, ...mismatch.calls].every(call => call.method === 'GET'));
  }
  const app = fixture(t, call => call.method === 'POST' ? task('new') : call.path === 'team/101/space' ? { spaces: [] } : hierarchy(call), { env: { CLICKUP_API_TOKEN: TOKEN, CLICKUP_WORKSPACE_ID: '101' } });
  writeFileSync(join(app.cwd, '.clickup-axi.json'), JSON.stringify({ workspace: '102', list: '200' }));
  assert.equal((await app.execute('task', ['create', '--name', 'x', '--workspace', 'Work'])).action, 'created');
  assert.ok(app.calls.some(call => call.path === 'team/100/space'));
  await assert.rejects(app.execute('task', ['create', '--name', 'x']), { code: 'VALIDATION_ERROR' });
  assert.equal(app.calls.filter(call => call.method !== 'GET').length, 1);
  const project = fixture(t, call => call.path === 'team/102/space' ? { spaces: [] } : hierarchy(call));
  writeFileSync(join(project.cwd, '.clickup-axi.json'), JSON.stringify({ workspace: '102', list: '200' }));
  await assert.rejects(project.execute('task', ['create', '--name', 'x', '--dry-run']), { code: 'VALIDATION_ERROR' });
  assert.ok(project.calls.every(call => call.method === 'GET'));
});

test('named assignee pagination keeps List-only scope and Tasks in Multiple Lists', async t => {
  const app = fixture(t, call => call.path.endsWith('/task') ? { tasks: Array.from({ length: 100 }, (_, i) => task(`t${i}`)) } : basics(call));
  for (const [command, args, cursor] of [['tasks', [], '--page 1'], ['search', ['Fix', '--pages', '1'], '--offset 2']]) {
    const first = await app.execute(command, [...args, '--list', '200', '--assignee', 'Alice', '--limit', '2']);
    assert.equal(first.scope.workspace, undefined);
    const hint = first.help.find(hint => hint.includes(cursor));
    assert.ok(hint);
    assert.ok(!hint.includes('--workspace'));
    const [root, ...argv] = hint.match(/`([^`]+)`/)[1].slice(invocation(ENTRY, app.config).command.length + 1).split(' ');
    const next = await app.execute(root, argv);
    assert.equal(next.scope.workspace, undefined);
    assert.equal(app.calls.at(-1).path, 'list/200/task');
    assert.equal(app.calls.at(-1).query.include_timl, 'true');
  }
});

test('parent updates reject self-parenting, cross-List parents, and ancestor cycles', async t => {
  for (const parent of [task('abc123'), task('parent', { list: { id: '201' } }), task('parent', { parent: 'child' })]) {
    const app = fixture(t, call => call.path === 'task/parent' ? parent : call.path === 'task/child' ? task('child', { parent: 'abc123' }) : task());
    await assert.rejects(app.execute('task', ['update', 'abc123', '--parent', 'parent', '--name', 'New']), { code: 'VALIDATION_ERROR' });
    assert.ok(app.calls.every(call => call.method === 'GET'));
  }
  let current = task();
  const app = fixture(t, call => {
    if (call.path === 'task/parent') return task('parent');
    if (call.method === 'PUT') current = { ...current, ...call.body };
    return current;
  });
  const dry = await app.execute('task', ['update', 'abc123', '--parent', 'parent', '--dry-run']);
  assert.deepEqual(dry.requests[0].body, { parent: 'parent' });
  assert.equal((await app.execute('task', ['update', 'abc123', '--parent', 'parent'])).changed, true);
  assert.equal((await app.execute('task', ['update', 'abc123', '--parent', 'parent'])).changed, false);
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
});

test('description appends keep Markdown, read in dry runs, and are not idempotent', async t => {
  let current = task('abc123', { markdown_description: '**Keep this**' });
  const app = fixture(t, call => {
    if (call.method === 'GET') assert.equal(call.query.include_markdown_description, 'true');
    else current = { ...current, markdown_description: call.body.markdown_content };
    return current;
  });
  const args = ['update', 'abc123', '--append-description=- Added'];
  const dry = await app.execute('task', [...args, '--dry-run']);
  assert.deepEqual(dry.requests[0].body, { markdown_content: '**Keep this**\n\n- Added' });
  assert.equal(app.calls.length, 1);
  await app.execute('task', args);
  await app.execute('task', args);
  assert.equal(current.markdown_description, '**Keep this**\n\n- Added\n\n- Added');
  const missing = fixture(t, () => task());
  await assert.rejects(missing.execute('task', args), { code: 'API_RESPONSE' });
  assert.deepEqual(missing.calls.map(call => call.method), ['GET']);
});

test('tag changes use canonical names, escaped paths, no-op checks, and empty success responses', async t => {
  let current = task('abc123', { tags: [{ name: 'Old' }] });
  const app = fixture(t, call => {
    if (call.path === 'space/300/tag') return { tags: [{ name: 'Bug / triage?' }] };
    if (call.method === 'POST') { current.tags.push({ name: 'Bug / triage?' }); return new Response(null, { status: 204 }); }
    if (call.method === 'DELETE') { current.tags = current.tags.filter(tag => tag.name !== 'Old'); return new Response(''); }
    if (call.method === 'PUT') current = { ...current, ...call.body };
    return current;
  });
  const args = ['update', 'abc123', '--add-tag', 'bug / triage?', '--remove-tag', 'old', '--name', 'New'];
  const dry = await app.execute('task', [...args, '--dry-run']);
  assert.deepEqual(dry.requests.map(request => request.method), ['POST', 'DELETE', 'PUT']);
  assert.ok(app.calls.every(call => call.method === 'GET'));
  const result = await app.execute('task', args);
  assert.equal(result.task.tags, 'Bug / triage?');
  assert.deepEqual(app.calls.slice(-3).map(call => call.path), ['task/abc123/tag/Bug%20%2F%20triage%3F', 'task/abc123/tag/Old', 'task/abc123']);
  assert.equal((await app.execute('task', args)).changed, false);
  assert.equal(app.calls.filter(call => call.method !== 'GET').length, 3);
  const removed = await app.execute('task', ['update', 'abc123', '--remove-tag', 'Bug / triage?']);
  assert.equal(removed.task.tags, '');
});

test('missing tags and invalid statuses prevent all writes, including other field changes', async t => {
  const app = fixture(t, call => call.path === 'task/abc123' ? task() : hierarchy(call));
  for (const args of [
    ['update', 'abc123', '--name', 'New', '--add-tag', 'Bu'],
    ['update', 'abc123', '--status', 'bogus', '--add-tag', 'Bug'],
    ['create', '--list', '200', '--name', 'New', '--tag', 'New tag'],
  ]) await assert.rejects(app.execute('task', args), { code: 'NAME_NOT_FOUND' });
  assert.ok(app.calls.every(call => call.method === 'GET'));
});

test('partial tag edits report confirmed writes and never retry or roll back', async t => {
  const app = fixture(t, call => {
    if (call.method === 'DELETE') return new Response('', { status: 500 });
    if (call.method === 'POST') return {};
    if (call.path === 'space/300/tag') return { tags: [{ name: 'Bug' }] };
    return task('abc123', { tags: [{ name: 'Old' }] });
  });
  await assert.rejects(app.execute('task', ['update', 'abc123', '--add-tag', 'Bug', '--remove-tag', 'Old', '--name', 'New']), error => {
    assert.equal(error.code, 'PARTIAL_WRITE');
    assert.match(error.message, /1 of 3.*may also have succeeded/);
    assert.ok(error.suggestions.some(hint => hint.includes('No rollback')));
    return true;
  });
  assert.deepEqual(app.calls.map(call => call.method), ['GET', 'GET', 'POST', 'DELETE']);
});

test('close previews by default, uses closed not done, and --dry-run overrides --yes', async t => {
  let current = task('abc123', { status: { status: 'done', type: 'done' } });
  const app = fixture(t, call => {
    if (call.path === 'list/200') return list();
    if (call.method === 'PUT') current = task('abc123', { status: { status: call.body.status, type: 'closed' } });
    return current;
  });
  for (const flags of [[], ['--yes', '--dry-run']]) {
    const result = await app.execute('task', ['close', 'abc123', ...flags]);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.requests[0].body, { status: 'closed' });
    assert.equal(result.task.name, 'Fix login');
  }
  assert.ok(app.calls.every(call => call.method === 'GET'));
  assert.equal((await app.execute('task', ['close', 'abc123', '--yes'])).action, 'closed');
  const before = app.calls.length;
  assert.equal((await app.execute('task', ['close', 'abc123', '--yes'])).changed, false);
  assert.equal(app.calls.length, before + 1);
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
  for (const statuses of [[], [{ status: 'done', type: 'done' }], [{ status: 'a', type: 'closed' }, { status: 'b', type: 'closed' }]]) {
    const bad = fixture(t, call => call.path === 'list/200' ? { statuses } : task());
    await assert.rejects(bad.execute('task', ['close', 'abc123', '--yes']), { code: 'API_RESPONSE' });
    assert.ok(bad.calls.every(call => call.method === 'GET'));
  }
});

test('moves change only the home List with one v3 request and resolve custom task IDs', async t => {
  const app = fixture(t, call => {
    if (call.path === 'team/100/space') return { spaces: [{ id: '300', name: 'Dev' }] };
    if (call.path === 'list/201') return list('201', { name: 'Next' });
    if (call.version === 'v3') return new Response('');
    return task('abc123');
  });
  const args = ['move', 'PROJ-42', '--workspace', '100', '--list', '201'];
  const dry = await app.execute('task', [...args, '--dry-run']);
  assert.equal(dry.path, '/api/v3/workspaces/100/tasks/abc123/home_list/201');
  assert.deepEqual(dry.body, {});
  assert.ok(app.calls.every(call => call.method === 'GET'));
  const result = await app.execute('task', args);
  assert.equal(result.action, 'moved');
  assert.equal(result.from.id, '200');
  assert.equal(result.to.id, '201');
  assert.deepEqual(app.calls.filter(call => call.method !== 'GET').map(call => [call.version, call.method, call.path, call.body]), [
    ['v3', 'PUT', 'workspaces/100/tasks/abc123/home_list/201', {}],
  ]);
  const before = app.calls.length;
  assert.equal((await app.execute('task', ['move', 'abc123', '--list', '200'])).changed, false);
  assert.equal(app.calls.length, before + 1);
});

test('moves require explicit status remaps and never add a hidden status write', async t => {
  const app = fixture(t, call => call.path === 'team/100/space' ? { spaces: [{ id: '300', name: 'Dev' }] } : call.path === 'list/201' ? list('201', { statuses: [{ id: 'queue-id', status: 'Queued', type: 'open' }] }) : task('abc123', { team_id: '100' }));
  const args = ['move', 'abc123', '--workspace', '100', '--list', '201'];
  await assert.rejects(app.execute('task', args), { code: 'VALIDATION_ERROR' });
  await assert.rejects(app.execute('task', [...args, '--status', 'absent']), { code: 'NAME_NOT_FOUND' });
  const dry = await app.execute('task', [...args, '--status', 'queued', '--dry-run']);
  assert.deepEqual(dry.body, { status_mappings: [{ source_status: 'open-id', destination_status: 'queue-id' }] });
  assert.equal(dry.status, 'Queued');
  assert.ok(app.calls.every(call => call.method === 'GET'));
  const kept = fixture(t, call => call.path === 'team/100/space' ? { spaces: [{ id: '300', name: 'Dev' }] } : call.path === 'list/201' ? list('201') : task('abc123', { team_id: '100' }));
  await assert.rejects(kept.execute('task', [...args, '--status', 'closed']), { code: 'VALIDATION_ERROR' });
  assert.ok(kept.calls.every(call => call.method === 'GET'));
});

test('dashboard, task lists, and bounded search all request newest updates first', async t => {
  const app = fixture(t, call => {
    assert.equal(call.query.order_by, 'updated');
    const names = call.query.reverse === 'false' ? ['newest', 'oldest'] : ['oldest', 'newest'];
    return { tasks: names.map(name => task(name, { name })) };
  });
  writeFileSync(join(app.cwd, '.clickup-axi.json'), JSON.stringify({ list: '200' }));
  for (const [command, args] of [['tasks', []], ['search', ['e', '--pages', '1']]]) {
    const result = await app.execute(command, [...args, '--assignee', 'all']);
    assert.equal(result.tasks[0].id, 'newest');
  }
  const home = fixture(t, call => call.path === 'user' ? basics(call) : { tasks: [task(call.query.reverse === 'false' ? 'newest' : 'oldest')] }, { env: { CLICKUP_API_TOKEN: TOKEN, CLICKUP_LIST_ID: '200' } });
  assert.equal((await home.execute('home')).tasks[0].id, 'newest');
});

test('CLICKUP_API_TOKEN is the only supported token environment variable', async t => {
  for (const env of [
    { CLICKUP_API_TOKEN: TOKEN },
    { CLICKUP_API_TOKEN: TOKEN, CLICKUP_TOKEN: 'pk_ignored_alias' },
  ]) {
    const app = fixture(t, basics, { env });
    assert.equal((await app.execute('workspaces')).count, 1);
    assert.equal(app.calls.length, 1);
  }
  for (const token of [undefined, '', 'bad token']) {
    const app = fixture(t, undefined, { env: { CLICKUP_API_TOKEN: token, CLICKUP_TOKEN: TOKEN } });
    await assert.rejects(app.execute('workspaces'), { code: 'AUTH_REQUIRED' });
    assert.equal(app.calls.length, 0);
  }
  const rejected = fixture(t, () => new Response('', { status: 401 }), { env: { CLICKUP_API_TOKEN: TOKEN, CLICKUP_TOKEN: 'pk_ignored_alias' } });
  await assert.rejects(rejected.execute('workspaces'), error => error.code === 'HTTP_401' && error.suggestions[0].includes('CLICKUP_API_TOKEN'));
  assert.equal(rejected.calls.length, 1);
});

test('credentials are read once per command and refreshed for the next command', async t => {
  const env = { CLICKUP_API_TOKEN: TOKEN };
  const app = fixture(t, call => {
    env.CLICKUP_API_TOKEN = '';
    return call.path.endsWith('/comment') ? { comments: [] } : task();
  }, { env });
  mkdirSync(join(app.cwd, '.env'));
  await app.execute('task', ['abc123']);
  assert.equal(app.calls.length, 2);
  await assert.rejects(app.execute('task', ['abc123']), { code: 'AUTH_REQUIRED' });
  assert.equal(app.calls.length, 2);
});

test('environment wins over .env, which supplies only CLICKUP_API_TOKEN without executing code', async t => {
  const env = {};
  const app = fixture(t, basics, { env });
  const content = `CLICKUP_TOKEN=ignored\nCLICKUP_WORKSPACE_ID=bad\nOTHER=$(touch should-not-exist)\nexport CLICKUP_API_TOKEN='${TOKEN}' # comment\n`;
  writeFileSync(join(app.cwd, '.env'), content);
  assert.equal((await app.execute('workspaces')).count, 1);
  assert.equal(readToken(env, app.cwd), TOKEN);
  assert.deepEqual(env, {});
  assert.equal(existsSync(join(app.cwd, 'should-not-exist')), false);
  assert.equal(readFileSync(join(app.cwd, '.env'), 'utf8'), content);
  env.CLICKUP_API_TOKEN = TOKEN;
  writeFileSync(join(app.cwd, '.env'), 'CLICKUP_API_TOKEN=bad');
  assert.equal((await app.execute('workspaces')).count, 1);
  env.CLICKUP_API_TOKEN = '';
  await assert.rejects(app.execute('workspaces'), { code: 'AUTH_REQUIRED' });
  assert.equal(app.calls.length, 2);
});

test('.env lookup uses the closest token and stops at the Git boundary', async t => {
  const app = fixture(t, basics, { env: {} });
  writeFileSync(join(app.cwd, '.env'), `CLICKUP_API_TOKEN=${TOKEN}\n`);
  mkdirSync(join(app.cwd, 'sub', 'nested'), { recursive: true });
  writeFileSync(join(app.cwd, 'sub', '.env'), 'UNRELATED=1');
  const cwd = join(app.cwd, 'sub', 'nested');
  assert.equal(readToken({}, cwd), TOKEN);
  writeFileSync(join(app.cwd, 'sub', '.env'), 'CLICKUP_API_TOKEN=pk_closest\n');
  assert.equal(readToken({}, cwd), 'pk_closest');
  mkdirSync(join(cwd, '.git'));
  assert.throws(() => readToken({}, cwd), { code: 'AUTH_REQUIRED' });
  assert.equal(app.calls.length, 0);
});

test('unusable .env files fail without API access or exposing their contents', async t => {
  for (const content of [null, 'x'.repeat(1024 * 1024 + 1), `CLICKUP_API_TOKEN="${TOKEN} bad"`]) {
    const app = fixture(t, undefined, { env: {} });
    if (content === null) mkdirSync(join(app.cwd, '.env'));
    else writeFileSync(join(app.cwd, '.env'), content);
    const result = await output(['workspaces'], app.config);
    assert.equal(result.code, 1);
    assert.ok(!result.text.includes(TOKEN));
    assert.equal(app.calls.length, 0);
  }
});

test('a rejected environment credential never selects a .env token', async t => {
  const app = fixture(t, () => new Response('', { status: 401 }));
  writeFileSync(join(app.cwd, '.env'), 'CLICKUP_API_TOKEN=pk_other_identity');
  await assert.rejects(app.execute('workspaces'), { code: 'HTTP_401' });
  assert.equal(app.calls.length, 1);
});

test('removed auth commands fail without reading credentials or writing files', async t => {
  const app = fixture(t, undefined, { env: {} });
  mkdirSync(join(app.cwd, '.env'));
  for (const args of [[], ['login', TOKEN], ['login', '--token-stdin'], ['logout'], ['status']]) {
    const result = await output(['auth', ...args], app.config);
    assert.equal(result.code, 2);
    assert.ok(!result.text.includes(TOKEN));
  }
  assert.equal(existsSync(join(app.cwd, 'home')), false);
  assert.equal(app.calls.length, 0);
});

test('authentication and HTTP failures are structured, redacted, and never retried', async t => {
  const missing = fixture(t, undefined, { env: {} });
  const auth = await output(['workspaces'], missing.config);
  assert.equal(auth.code, 1);
  assert.match(auth.text, /AUTH_REQUIRED/);
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const app = fixture(t, () => new Response(`${TOKEN} private HTML`, { status, headers: { 'retry-after': '30' } }));
    const result = await output(['task', 'comment', 'abc123', '--text', 'Hello'], app.config);
    assert.equal(result.code, 1);
    assert.match(result.text, /error:/);
    assert.ok(!result.text.includes(TOKEN));
    assert.ok(!result.text.includes('private HTML'));
    assert.equal(app.calls.length, 1);
    if (status === 429) assert.match(result.text, /Wait 30 seconds/);
    if (status === 500) assert.match(result.text, /may have succeeded/);
  }
});

test('network and malformed responses never become false empty results', async t => {
  const variants = [() => { throw new Error(TOKEN); }, () => new Response('bad JSON'), () => ({}), () => ({ tasks: 'wrong' })];
  for (const handler of variants) {
    const app = fixture(t, handler);
    const result = await output(['tasks', '--list', '200', '--assignee', 'all'], app.config);
    assert.equal(result.code, 1);
    assert.ok(!result.text.includes(TOKEN));
    assert.ok(!result.text.includes('0 tasks'));
    assert.equal(app.calls.length, 1);
  }
});

test('timeouts work without exposing credentials', async () => {
  const client = createClient({ env: { CLICKUP_API_TOKEN: TOKEN }, timeoutMs: 1, fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Authorization, TOKEN);
    init.signal.throwIfAborted();
    await new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('test timeout')), 50);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
  } });
  await assert.rejects(client('POST', 'task/abc123/comment', {}, {}), error => error.code === 'REQUEST_FAILED' && error.suggestions[0].includes('may have succeeded'));
});

test('TOON output safely quotes numeric IDs, commas, quotes, and newlines', async t => {
  const app = fixture(t, () => ({ tasks: [task('123', { name: 'A, "B"\nC' })] }));
  const result = await output(['tasks', '--list', '200', '--assignee', 'all'], app.config);
  assert.equal(result.code, 0);
  assert.match(result.text, /tasks\[1\]\{id,name,status,list\}/);
  assert.ok(result.text.includes('"123","A, \\"B\\"\\nC"'));
});

test('hook setup is opt-in, repeatable, and removes only managed entries in a fake home', async t => {
  const app = fixture(t);
  const configFile = join(app.cwd, '.claude', 'settings.json');
  mkdirSync(join(app.cwd, '.claude'));
  writeFileSync(configFile, JSON.stringify({ other: true, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }));
  assert.equal((await app.execute('setup', ['status'])).claude.installed, false);
  assert.equal(existsSync(join(app.cwd, 'home')), false);
  const installed = await app.execute('setup', ['hooks']);
  assert.equal(installed.claude.installed, true);
  assert.equal(installed.codex.userFeatureEnabled, true);
  assert.equal(installed.opencode.installed, true);
  const first = readFileSync(configFile, 'utf8');
  await app.execute('setup', ['hooks']);
  assert.equal(readFileSync(configFile, 'utf8'), first);
  const removed = await app.execute('setup', ['remove']);
  assert.equal(removed.claude.installed, false);
  assert.equal(removed.opencode.installed, false);
  assert.equal(removed.codex.userFeatureEnabled, true);
  const remaining = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(remaining.other, true);
  assert.equal(remaining.hooks.SessionStart[0].hooks[0].command, 'echo keep');
  assert.equal(app.calls.length, 0);
});

test('hook setup reports malformed host config instead of overwriting it', async t => {
  const app = fixture(t);
  mkdirSync(join(app.cwd, '.claude'));
  const path = join(app.cwd, '.claude', 'settings.json');
  writeFileSync(path, 'invalid JSON');
  await assert.rejects(app.execute('setup', ['hooks']), { code: 'SETUP_ERROR' });
  assert.equal(readFileSync(path, 'utf8'), 'invalid JSON');
});

test('hook setup safely quotes executable paths with spaces and shell symbols', async t => {
  const execPath = resolve("path with spaces/Bob's $tools/clickup-axi.mjs");
  const app = fixture(t, undefined, { execPath });
  const result = await app.execute('setup', ['hooks']);
  const hook = JSON.parse(readFileSync(result.claude.path)).hooks.SessionStart[0].hooks[0];
  assert.equal(hook.command, invocation(execPath, app.config).command + ' # clickup-axi managed');
  await app.execute('setup', ['remove']);
  assert.deepEqual(JSON.parse(readFileSync(result.claude.path)), {});
});

test('numeric List and Folder discovery enforce explicit workspace ownership', async t => {
  for (const [command, args] of [['list', ['200']], ['lists', ['--folder', '400']]]) {
    const matching = fixture(t, hierarchy);
    const result = await matching.execute(command, [...args, '--workspace', 'Work']);
    assert.ok(result.list || result.lists);
    assert.ok(matching.calls.some(call => call.path === 'team/100/space'));
    const wrong = fixture(t, call => call.path === 'team/101/space' ? { spaces: [] } : hierarchy(call));
    await assert.rejects(wrong.execute(command, [...args, '--workspace', '101']), { code: 'VALIDATION_ERROR' });
    assert.ok(wrong.calls.every(call => call.method === 'GET'));
    if (command === 'lists') assert.ok(!wrong.calls.some(call => call.path === 'folder/400/list'));
  }
});

test('internal task detail, comments, and comment writes enforce explicit workspace', async t => {
  const commands = [['task', ['abc123']], ['comments', ['abc123']], ['task', ['comment', 'abc123', '--text', 'Hello']], ['task', ['comment', 'abc123', '--text', 'Hello', '--dry-run']]];
  for (const [command, args] of commands) {
    for (const team_id of ['101', undefined]) {
      const app = fixture(t, () => task('abc123', { team_id }));
      await assert.rejects(app.execute(command, [...args, '--workspace', '100']), { code: team_id ? 'VALIDATION_ERROR' : 'API_RESPONSE' });
      assert.deepEqual(app.calls.map(call => call.path), ['task/abc123']);
      assert.ok(app.calls.every(call => call.method === 'GET'));
    }
    const app = fixture(t, call => call.path === 'team' ? basics(call) : call.path.endsWith('/comment') ? call.method === 'GET' ? { comments: [] } : { id: '123' } : task('abc123', { team_id: '100' }));
    await app.execute(command, [...args, '--workspace', 'Work']);
    assert.equal(app.calls.filter(call => call.path === 'task/abc123').length, 1);
    assert.equal(app.calls.filter(call => call.method === 'POST').length, args[0] === 'comment' && !args.includes('--dry-run') ? 1 : 0);
  }
});

test('discovery hints carry resolved scope and select List IDs from the Folder inventory', async t => {
  const app = fixture(t, hierarchy);
  const spaces = await app.execute('spaces', ['--workspace', 'Work']);
  assert.ok(spaces.help.every(hint => hint.includes('--workspace 100')));
  const folders = await app.execute('folders', ['--space', 'Dev', '--workspace', 'Work']);
  assert.ok(folders.help.every(hint => hint.includes('--space 300') && hint.includes('--workspace 100')));
  const lists = await app.execute('lists', ['--folder', '400', '--workspace', 'Work']);
  assert.equal(lists.scope.folder, '400');
  assert.ok(lists.help.every(hint => hint.includes('--space 300') && hint.includes('--workspace 100') && hint.includes('choose a List ID from these results')));
  const tasks = await app.execute('tasks', ['--list', '200', '--space', 'Dev', '--workspace', 'Work']);
  assert.equal(tasks.scope.space, '300');
  assert.equal(app.calls.at(-1).query['space_ids[]'], '300');
});

test('default output omits scan-only metadata, null scope, duplicate bodies, and irrelevant hints', async t => {
  const app = fixture(t, call => call.path.endsWith('/comment') ? { comments: [] } : call.path.endsWith('/task') ? { tasks: [] } : task());
  const empty = await app.execute('tasks', ['--list', '200', '--assignee', 'all']);
  assert.deepEqual(empty.scope, { list: '200', assignee: 'all', includeClosed: false });
  assert.equal(empty.totalCount, 0);
  for (const key of ['scanned', 'matchedInScan', 'firstPage', 'pages']) assert.ok(!Object.hasOwn(empty, key));
  assert.ok(empty.help.every(hint => !hint.includes(' task <id>')));
  assert.ok(empty.help[0].includes('--list 200'));
  const detail = await app.execute('task', ['abc123']);
  assert.equal(detail.help, undefined);
  const noop = await app.execute('task', ['update', 'abc123', '--name', 'Fix login']);
  assert.equal(noop.help, undefined);
  const dry = await app.execute('task', ['update', 'abc123', '--name', 'New', '--dry-run']);
  assert.equal(dry.body, undefined);
  assert.deepEqual(dry.requests[0].body, { name: 'New' });
  assert.equal(dry.help, undefined);
});

test('help invocation changes never rewrite user data or name candidates', async t => {
  const name = 'clickup-axi `clickup-axi task <id>`';
  const app = fixture(t, call => call.path === 'team' ? { teams: [{ id: '1', name }, { id: '2', name }] } : { tasks: [task('abc123', { name })] });
  const data = await app.execute('tasks', ['--list', '200', '--assignee', 'all']);
  assert.equal(data.tasks[0].name, name);
  await assert.rejects(app.execute('spaces', ['--workspace', 'clickup-axi']), error => {
    assert.equal(error.code, 'AMBIGUOUS_NAME');
    assert.ok(error.suggestions[0].includes(JSON.stringify(name)));
    return true;
  });
});
