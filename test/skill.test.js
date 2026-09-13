import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ENTRY, invocation } from '../skills/clickup-axi/scripts/invocation.mjs';
import { createApp } from '../skills/clickup-axi/scripts/cli.mjs';
import { VERSION } from '../skills/clickup-axi/scripts/version.mjs';

function machine(t) {
  const root = mkdtempSync(join(tmpdir(), 'clickup-skill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = join(root, "Bob's $skills", 'clickup-axi');
  cpSync(fileURLToPath(new URL('../skills/clickup-axi', import.meta.url)), skill, { recursive: true });
  const cwd = join(root, 'project', 'child');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'project', '.git'));
  const env = { HOME: join(root, 'home'), PATH: join(root, 'empty-path') };
  const entry = join(skill, 'scripts', 'clickup-axi.mjs');
  const run = (...args) => spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' });
  return { root, skill, cwd, env, entry, run };
}

test('a copied skill runs version, help, dashboard, and fake task reads in the user project', t => {
  const { root, skill, cwd, env, entry, run } = machine(t);
  assert.equal(existsSync(join(root, 'node_modules')), false);
  assert.equal(existsSync(join(skill, 'package.json')), false);
  for (const flag of ['-v', '-V', '--version', '--help']) {
    const result = run(entry, flag);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    if (flag !== '--help') assert.equal(result.stdout, VERSION + '\n');
    else assert.ok(result.stdout.includes(invocation(entry, { cwd, env }).command));
  }
  writeFileSync(join(root, '.env'), 'CLICKUP_API_TOKEN=pk_outside_git');
  writeFileSync(join(root, 'project', '.env'), 'CLICKUP_API_TOKEN=pk_fake_project');
  writeFileSync(join(cwd, '.env'), 'UNRELATED=1');
  writeFileSync(join(root, 'project', '.clickup-axi.json'), '{"list":"200"}');
  const preload = join(root, 'fake-api.mjs');
  writeFileSync(preload, `import assert from 'node:assert/strict';
    assert.equal(process.cwd(), ${JSON.stringify(cwd)});
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, 'pk_fake_project');
      assert.equal(init.method, 'GET');
      if (url.pathname === '/api/v2/user') return Response.json({user:{id:7}});
      assert.equal(url.pathname, '/api/v2/list/200/task');
      assert.equal(url.searchParams.get('include_timl'), 'true');
      return Response.json({tasks:[{id:'abc123',name:'Fake project task',status:{status:'open'},list:{id:'200',name:'Sprint'}}],last_page:true});
    };`);
  for (const args of [[], ['tasks']]) {
    const result = run('--import', preload, entry, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Fake project task/);
    assert.match(result.stdout, /totalCount: 1/);
  }
  rmSync(join(root, 'project', '.env'));
  const blocked = run('--import', preload, entry, 'tasks');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /AUTH_REQUIRED/);
  mkdirSync(join(cwd, '.clickup-axi.json'));
  for (const args of [['task', 'update', '--help'], ['auth'], ['tasks', '--stat', 'closed']]) {
    const result = run(entry, ...args);
    assert.equal(result.status, args.includes('--help') ? 0 : 2, result.stdout);
    assert.doesNotMatch(result.stdout, /AUTH_REQUIRED|CONFIG_ERROR/);
    if (args[0] === 'auth') assert.match(result.stdout, /auth command was removed.*CLICKUP_API_TOKEN/);
    if (args.includes('--stat')) assert.match(result.stdout, /Valid flags for tasks:.*--status/);
  }
});

test('invocation verifies the first executable on PATH and quotes a skill-only fallback', async t => {
  const { root, entry, cwd, env } = machine(t);
  const bin = join(root, 'bin');
  const other = join(root, 'other');
  mkdirSync(bin); mkdirSync(other);
  chmodSync(entry, 0o755);
  symlinkSync(entry, join(bin, 'clickup-axi'));
  symlinkSync(entry, join(cwd, 'clickup-axi'));
  assert.notEqual(invocation(entry, { cwd, env: {} }).command, 'clickup-axi');
  assert.equal(invocation(entry, { cwd, env: { PATH: '' } }).command, 'clickup-axi');
  assert.equal(invocation(entry, { cwd, env: { PATH: bin } }).command, 'clickup-axi');
  const foreign = join(other, 'clickup-axi');
  writeFileSync(foreign, '#!/bin/sh\necho unrelated\n');
  chmodSync(foreign, 0o755);
  const selected = invocation(entry, { cwd, env: { PATH: `${other}${delimiter}${bin}` } });
  assert.notEqual(selected.command, 'clickup-axi');
  const result = spawnSync('/bin/sh', ['-c', `${selected.command} --version`], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, VERSION + '\n');
  const homeDir = join(root, 'home');
  const app = createApp({ cwd, homeDir, execPath: entry, env: { PATH: bin }, fetchImpl: () => assert.fail('No API access') });
  assert.ok((await app.execute('tasks', ['--help'])).command.startsWith('clickup-axi tasks'));
  const installed = await app.execute('setup', ['hooks']);
  const path = installed.claude.path;
  assert.equal(JSON.parse(readFileSync(path)).hooks.SessionStart[0].hooks[0].command, 'clickup-axi # clickup-axi managed');
  const fallback = createApp({ cwd, homeDir, execPath: entry, env: { PATH: other }, fetchImpl: () => assert.fail('No API access') });
  await fallback.execute('setup', ['hooks']);
  const repaired = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(repaired).hooks.SessionStart[0].hooks[0].command, selected.command + ' # clickup-axi managed');
  await fallback.execute('setup', ['hooks']);
  assert.equal(readFileSync(path, 'utf8'), repaired);
  const source = readFileSync(installed.opencode.path, 'utf8');
  assert.ok(source.includes(JSON.stringify(entry)));
  const preload = join(root, 'fake-hook-api.mjs');
  writeFileSync(preload, `import assert from 'node:assert/strict';
    assert.equal(process.cwd(), ${JSON.stringify(cwd)});
    globalThis.fetch = async () => Response.json({teams:[{id:'100',name:'Fake scoped hook'}]});`);
  for (const config of [installed.claude.path, installed.codex.path]) {
    const command = JSON.parse(readFileSync(config)).hooks.SessionStart[0].hooks[0].command;
    const result = spawnSync('/bin/sh', ['-c', command], { cwd, env: { ...env, CLICKUP_API_TOKEN: 'pk_fake_hook', NODE_OPTIONS: `--import=${preload}` }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Fake scoped hook/);
  }

  await fallback.execute('setup', ['remove']);
  assert.deepEqual(JSON.parse(readFileSync(path)), {});
});

test('bare version aliases do not load the command graph and stay near the Node startup floor', t => {
  const { skill, entry, run } = machine(t);
  writeFileSync(join(skill, 'scripts', 'cli.mjs'), 'throw new Error("Command graph loaded");');
  for (const flag of ['-v', '-V', '--version']) {
    const result = run(entry, flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, VERSION + '\n');
  }
  assert.notEqual(run(entry, 'tasks', '--version').status, 0);
  const samples = { floor: [], version: [] };
  for (let i = 0; i < 7; i++) {
    for (const [key, args] of [['floor', ['-e', 'console.log(1)']], ['version', [ENTRY, '--version']]]) {
      const start = performance.now();
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      samples[key].push(performance.now() - start);
    }
  }
  const median = values => values.sort((a, b) => a - b)[3];
  const floor = median(samples.floor), version = median(samples.version);
  t.diagnostic(`Node console.log median ${floor.toFixed(2)} ms; version median ${version.toFixed(2)} ms; ratio ${(version / floor).toFixed(2)}`);
  assert.ok(version < floor * 3, `version ${version} ms, Node floor ${floor} ms`);
});

test('home identifies the actual entry with the home directory collapsed', async t => {
  const { root, entry, cwd, env } = machine(t);
  const { main } = await import('../skills/clickup-axi/scripts/cli.mjs');
  let text = '';
  await main([], { cwd, env: { ...env, CLICKUP_API_TOKEN: 'pk_fake_home' }, execPath: entry, homeDir: root, stdout: { write: value => { text += value; } }, fetchImpl: async () => Response.json({ teams: [] }) });
  assert.ok(text.includes(`~${entry.slice(root.length)}`));
  assert.match(text, /0 workspaces found/);
});
