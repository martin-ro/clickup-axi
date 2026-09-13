import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/cli.js';
import { readToken } from '../src/api.js';
import { renderOutput } from '../src/output.js';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'clickup-axi-native-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.git'));
  const homeDir = join(cwd, 'home');
  return { cwd, homeDir, ...createApp({ cwd, homeDir, env: {}, fetchImpl: () => assert.fail('No API access') }) };
}

test('the package and lockfile contain no external dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.deepEqual(Object.keys(pkg[key] ?? {}), []);
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  assert.deepEqual(Object.keys(lock.packages), ['']);
});

test('TOON scalar quoting keeps strings, controls, and numbers distinct', () => {
  for (const text of ['', 'true', 'null', '01', '-2', '+3', '1e6', '#note', ' hi ', 'a,b', 'a:b', '[x]', '{x}', 'a"b', 'a\\b', 'a\nb', '\t', '\r']) {
    assert.equal(renderOutput(text), JSON.stringify(text));
  }
  assert.equal(renderOutput('\b\f\0\x1b'), '"\\u0008\\u000c\\u0000\\u001b"');
  assert.equal(renderOutput('hello 😀'), 'hello 😀');
  assert.equal(renderOutput(-0), '0');
  assert.equal(renderOutput([1e-7, 1e21, 1e-6, NaN, undefined]), '[5]: 1e-7,1e+21,0.000001,null,null');
  assert.throws(() => renderOutput('\ud800'), /surrogate/);
  assert.throws(() => renderOutput({ '\udfff': 1 }), /surrogate/);
});

test('TOON arrays, nested tables, empty values, and quoted keys use correct indentation', () => {
  assert.equal(renderOutput({ empty: [], object: {}, rows: [{ id: '1', user: { name: 'A' } }, { user: { name: 'B' }, id: '2' }] }),
    'empty: []\nobject:\nrows[2]{id,user{name}}:\n  "1",A\n  "2",B');
  assert.equal(renderOutput({ people: { a: { id: 1 }, b: { id: 2 } } }), 'people[2:]{id}:\n  a: 1\n  b: 2');
  assert.equal(renderOutput([{ rows: [{ id: 1 }], next: true }, {}]), '[2]:\n  - rows[1]{id}:\n      1\n    next: true\n  -');
  assert.equal(renderOutput([[{ id: 1 }, { id: 2 }], [], [true, false]]), '[3]:\n  - [2]:\n    - id: 1\n    - id: 2\n  - [0]:\n  - [2]: true,false');
  assert.equal(renderOutput([{ 'my key': { x: 1 }, list: [] }, null]), '[2]:\n  - "my key":\n      x: 1\n    list: []\n  - null');
  assert.equal(renderOutput([{ a: { id: 1 }, b: { id: 2 } }, {}]), '[2]:\n  - a:\n      id: 1\n    b:\n      id: 2\n  -');
  assert.equal(renderOutput({ 'x,y': [{ 'a,b': '1' }] }), '"x,y"[1]{"a,b"}:\n  "1"');
  assert.equal(renderOutput({}), '');
});

test('token validation rejects control characters, Unicode, and oversized input before .env lookup', t => {
  const app = fixture(t);
  mkdirSync(join(app.cwd, '.env'));
  for (const token of ['a b', 'a\nb', '😀', 'x'.repeat(4097)]) {
    assert.throws(() => readToken({ CLICKUP_API_TOKEN: token }, app.cwd), { code: 'AUTH_REQUIRED' });
  }
});

test('a broken .env link fails instead of selecting an ancestor token', t => {
  const app = fixture(t);
  const child = join(app.cwd, 'child');
  mkdirSync(child);
  writeFileSync(join(app.cwd, '.env'), 'CLICKUP_API_TOKEN=pk_ancestor');
  const target = join(app.cwd, 'missing');
  symlinkSync(target, join(child, '.env'));
  assert.throws(() => readToken({}, child), { code: 'CONFIG_ERROR' });
  writeFileSync(target, 'CLICKUP_API_TOKEN=pk_linked');
  assert.equal(readToken({}, child), 'pk_linked');
});

test('hook removal preserves foreign commands and migrates only our legacy hooks', async t => {
  const app = fixture(t);
  mkdirSync(join(app.cwd, '.claude'));
  const path = join(app.cwd, '.claude', 'settings.json');
  const keep = { type: 'command', command: 'echo clickup-axi' };
  writeFileSync(path, JSON.stringify({ hooks: { session_start: [{ type: 'command', command: 'clickup-axi' }, keep], SessionStart: [{ matcher: 'startup', hooks: [keep] }] } }));
  await app.execute('setup', ['hooks']);
  await app.execute('setup', ['remove']);
  assert.deepEqual(JSON.parse(readFileSync(path)), { hooks: { session_start: [keep], SessionStart: [{ matcher: 'startup', hooks: [keep] }] } });
});

test('global hooks stay in the fake home and change only the literal Codex flag', async t => {
  const app = fixture(t);
  mkdirSync(join(app.homeDir, '.codex'), { recursive: true });
  const path = join(app.homeDir, '.codex', 'config.toml');
  const content = 'model = "example"\r\n[ features ]\r\nother = false\r\nhooks = false # keep\r\n[next]\r\nvalue = 1\r\n';
  writeFileSync(path, content);
  const result = await app.execute('setup', ['hooks', '--global']);
  assert.equal(result.scope, 'user');
  assert.equal(result.codex.userFeatureEnabled, true);
  assert.equal(existsSync(join(app.cwd, '.claude')), false);
  assert.equal(readFileSync(path, 'utf8'), content.replace('hooks = false', 'hooks = true'));
  assert.equal(result.opencode.path, join(app.homeDir, '.config', 'opencode', 'plugins', 'axi-clickup-axi.js'));
  await app.execute('setup', ['remove', '--global']);
  assert.equal(readFileSync(path, 'utf8'), content.replace('hooks = false', 'hooks = true'));
});

test('complex Codex config and malformed hook structures are never replaced', async t => {
  for (const content of ['features = { hooks = true }', '["features"]\nhooks = true\n', 'text = """\n[features]\nhooks = false\n"""\n', '[features]\n"hooks" = false\n', '[[features]]\nhooks = false\n', '[features.hooks]\nvalue = false\n', '"fea\\u0074ures".hooks = false\n']) {
    const app = fixture(t);
    mkdirSync(join(app.homeDir, '.codex'), { recursive: true });
    const path = join(app.homeDir, '.codex', 'config.toml');
    writeFileSync(path, content);
    await assert.rejects(app.execute('setup', ['hooks']), { code: 'SETUP_ERROR' });
    assert.equal(readFileSync(path, 'utf8'), content);
    assert.equal((await app.execute('setup', ['status'])).codex.userFeatureEnabled, null);
  }
  for (const config of [null, [], { hooks: [] }, { hooks: { SessionStart: null } }, { hooks: { SessionStart: [{ hooks: 'bad' }] } }]) {
    const app = fixture(t);
    mkdirSync(join(app.cwd, '.claude'));
    const path = join(app.cwd, '.claude', 'settings.json');
    writeFileSync(path, JSON.stringify(config));
    await assert.rejects(app.execute('setup', ['hooks']), { code: 'SETUP_ERROR' });
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(config));
  }
});

test('unmanaged OpenCode files are never replaced or removed', async t => {
  const app = fixture(t);
  const dir = join(app.cwd, '.opencode', 'plugins');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'axi-clickup-axi.js');
  writeFileSync(path, '// User plugin');
  for (const action of ['hooks', 'remove']) {
    await assert.rejects(app.execute('setup', [action]), { code: 'SETUP_ERROR' });
    assert.equal(readFileSync(path, 'utf8'), '// User plugin');
  }
});

test('generated OpenCode plugin uses the project directory, caches once per session, and hides subprocess errors', async t => {
  const fixtureApp = fixture(t);
  mkdirSync(join(fixtureApp.cwd, 'bin'));
  const execPath = join(fixtureApp.cwd, 'bin', 'clickup-axi.js');
  writeFileSync(execPath, `const fs = require('node:fs'); fs.appendFileSync('calls', 'x'); process.stdout.write('cwd: ' + process.cwd());`);
  const app = createApp({ cwd: fixtureApp.cwd, homeDir: fixtureApp.homeDir, execPath, env: {}, fetchImpl: () => assert.fail('No API access') });
  const installed = await app.execute('setup', ['hooks']);
  const source = readFileSync(installed.opencode.path, 'utf8');
  const { ClickUpContext } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const hooks = await ClickUpContext({ directory: fixtureApp.cwd });
  const transform = hooks['experimental.chat.system.transform'];
  const output = { system: [] };
  await Promise.all([transform({ sessionID: 'one' }, output), transform({ sessionID: 'one' }, output)]);
  assert.equal(readFileSync(join(fixtureApp.cwd, 'calls'), 'utf8'), 'x');
  assert.ok(output.system.every(text => text.includes(`cwd: ${fixtureApp.cwd}`)));
  writeFileSync(execPath, 'throw new Error("pk_fake_secret");');
  await transform({ sessionID: 'two' }, output);
  assert.match(output.system.at(-1), /context failed/);
  assert.ok(!output.system.at(-1).includes('pk_fake_secret'));
});
