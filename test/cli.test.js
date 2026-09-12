import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp, main } from '../src/cli.js';
import { COMMANDS } from '../src/help.js';
import { createClient, projectConfig } from '../src/api.js';
import { VERSION } from '../src/version.js';

const TOKEN = 'pk_test_secret';
const task = (id = 'abc123', extra = {}) => ({
  id, name: 'Fix login', status: { status: 'open' }, description: 'Check redirects',
  list: { id: '200', name: 'Sprint' }, priority: null, due_date: null, assignees: [], ...extra,
});
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
      const call = { path: url.pathname.replace('/api/v2/', ''), query: Object.fromEntries(url.searchParams), method: init.method, body: init.body && JSON.parse(init.body) };
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
    ['task', ['../abc123']], ['folders', []], ['lists', ['--space', '1', '--folder', '2']],
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
  for (const command of Object.keys(COMMANDS)) {
    const [root, ...args] = command.split(' ');
    const data = await app.execute(root, [...args, '--help']);
    assert.ok(data.command.startsWith('clickup-axi '));
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

test('SDK boundary returns structured usage errors, including prototype names', async t => {
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
  assert.deepEqual(app.calls.at(-1).query, { subtasks: 'true', include_closed: 'false', order_by: 'updated', reverse: 'true', 'assignees[]': '7', 'statuses[]': 'in review', 'tags[]': 'a,b', page: '0' });
});

test('List-only reads include Tasks in Multiple Lists and avoid workspace lookup', async t => {
  const app = fixture(t, basics);
  const result = await app.execute('tasks', ['--list', '200', '--assignee', 'all', '--fields', 'id,priority,url']);
  assert.equal(result.scope.workspace, null);
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
  assert.equal(result.scanned, 100);
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
    if (call.method === 'PUT') current = { ...current, status: { status: call.body.status } };
    return current;
  });
  const first = await app.execute('task', ['update', 'abc123', '--status', 'closed']);
  assert.equal(first.changed, true);
  assert.equal(first.task.status, 'closed');
  const second = await app.execute('task', ['update', 'abc123', '--status', 'closed']);
  assert.equal(second.action, 'unchanged');
  assert.deepEqual(app.calls.map(call => call.method), ['GET', 'PUT', 'GET']);
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
  const created = await app.execute('task', ['create', '--name', 'New', '--list', '200', '--parent', 'abc123', '--assignee', '7', '--dry-run']);
  assert.deepEqual(created.body, { name: 'New', parent: 'abc123', assignees: [7] });
  const commented = await app.execute('task', ['comment', 'abc123', '--text', 'Hello', '--dry-run']);
  assert.deepEqual(commented.body, { comment_text: 'Hello', notify_all: false });
  await assert.rejects(app.execute('task', ['create', '--name', 'New']), { code: 'VALIDATION_ERROR' });
  assert.equal(app.calls.length, 0);
  const normal = fixture(t, () => task());
  assert.equal((await normal.execute('task', ['update', 'abc123', '--status', 'closed', '--dry-run'])).changed, true);
  assert.deepEqual(normal.calls.map(call => call.method), ['GET']);
});

test('create and comment write once and do not send notifications unless requested', async t => {
  const app = fixture(t, call => call.path.endsWith('/comment') ? { id: '123' } : task());
  assert.equal((await app.execute('task', ['create', '--name', 'New', '--list', '200'])).action, 'created');
  assert.equal((await app.execute('task', ['comment', 'abc123', '--text', 'Hello'])).comment.id, '123');
  assert.deepEqual(app.calls.map(call => call.method), ['POST', 'POST']);
  assert.deepEqual(app.calls[1].body, { comment_text: 'Hello', notify_all: false });
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

test('timeout and token aliases work without exposing credentials', async () => {
  const client = createClient({ env: { CLICKUP_TOKEN: TOKEN }, timeoutMs: 1, fetchImpl: async (_url, init) => {
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

test('hook setup rejects shell-unsafe executable paths without writing files', async t => {
  const app = fixture(t, undefined, { execPath: resolve('path with spaces/bin/clickup-axi.js') });
  await assert.rejects(app.execute('setup', ['hooks']), { code: 'VALIDATION_ERROR' });
  assert.equal(existsSync(join(app.cwd, '.claude')), false);
});
