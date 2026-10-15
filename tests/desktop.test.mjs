import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'target', process.platform === 'win32' ? 'debug/rdsh.exe' : 'debug/rdsh');
const windows = process.platform === 'win32';

// Desktop (Electron) owns the reserved `desktop` profile; the npm dsh CLI
// cannot manage it, so `rdsh desktop install` only forwards
// `plugin --profile desktop add` to the Desktop-installed command. These tests
// drive that forwarding against a stub command and a hermetic DSH_HOME: no
// Electron, no real DSH profile, no model calls.
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-desktop-'));
  const home = join(root, 'dsh');
  const checkout = join(root, 'rustdsh');
  for (const name of ['rdsh-settings', 'rdsh-translation', 'rdsh-compute']) {
    await mkdir(join(checkout, 'plugins', name), { recursive: true });
    await writeFile(join(checkout, 'plugins', name, 'package.json'), JSON.stringify({ name }));
  }
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, checkout, profile: join(home, 'profiles', 'desktop', 'package.json'), log: join(root, 'calls.log') };
}

// Stub for resources/runtime/cli/bin/dsh. It records argv and, for `add`,
// enables the package the way the shared plugin manager does (dependency plus
// an appended dsh.profile.bundles entry).
async function stubCommand(box) {
  const path = join(box.root, 'desktop-cli', 'dsh');
  await mkdir(join(box.root, 'desktop-cli'), { recursive: true });
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");',
    "const at = args.indexOf('add');",
    'if (at >= 0 && args[at - 1] !== undefined) {',
    '  const source = args[at + 1];',
    '  const name = path.basename(source);',
    '  const profile = process.env.STUB_PROFILE;',
    "  const doc = JSON.parse(fs.readFileSync(profile, 'utf8'));",
    '  doc.dependencies = doc.dependencies || {};',
    "  doc.dependencies[name] = 'link:' + source;",
    '  const bundles = (doc.dsh && doc.dsh.profile && doc.dsh.profile.bundles) || [];',
    '  if (!bundles.includes(name)) bundles.push(name);',
    "  doc.dsh = { profile: { bundles } };",
    "  fs.writeFileSync(profile, JSON.stringify(doc, null, 2) + '\\n');",
    '}',
  ];
  await writeFile(path, lines.join('\n') + '\n');
  await chmod(path, 0o755);
  return path;
}

async function run(args, env) {
  const options = { env: { ...process.env, ...env }, cwd: repo, maxBuffer: 4 * 1024 * 1024 };
  try {
    const { stdout, stderr } = await exec(bin, args, options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function baseEnv(t) {
  const box = await sandbox(t);
  return { box, env: { DSH_HOME: box.home } };
}

async function initProfile(box, doc) {
  await writeFile(box.profile, JSON.stringify(doc, null, 2) + '\n');
}

test('status is truthful with no Desktop app and no profile', async (t) => {
  const { env } = await baseEnv(t);
  const { code, stdout } = await run(['desktop', 'status', '--json'], { ...env, DSH_DESKTOP_CLI: '' });
  assert.equal(code, 0);
  const status = JSON.parse(stdout);
  assert.equal(status.available, false);
  assert.equal(status.profile.initialized, false);
  assert.equal(status.command.path, null);
  assert.deepEqual(status.profile.plugins.map((p) => [p.name, p.enabled]), [['rdsh-settings', false], ['rdsh-translation', false], ['rdsh-compute', false]]);
});
test('status reports the Desktop command and enabled plugins', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, {
    name: 'dsh-profile-desktop',
    dependencies: { 'rdsh-settings': 'link:/repo/plugins/rdsh-settings' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@local/rdsh-settings'] } },
  });
  const { code, stdout } = await run(['desktop', 'status', '--json'], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(code, 0);
  const status = JSON.parse(stdout);
  assert.equal(status.command.source, 'DSH_DESKTOP_CLI');
  assert.equal(status.command.path, command);
  assert.equal(status.profile.initialized, true);
  const settings = status.profile.plugins.find((p) => p.name === 'rdsh-settings');
  assert.deepEqual([settings.installed, settings.enabled], [true, true], 'scoped bundle alias counts as enabled');
});

test('install --dry-run prints the forwarded command and changes nothing', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const before = await readFile(box.profile, 'utf8');
  const { code, stdout } = await run(['desktop', 'install', '--dry-run', '--json', '--plugins-dir', box.checkout], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.dry_run, true);
  assert.equal(report.actions.length, 2);
  assert.equal(report.actions[0].plugin, 'rdsh-settings');
  assert.deepEqual(report.actions[0].args, ['plugin', '--profile', 'desktop', 'add', join(box.checkout, 'plugins', 'rdsh-settings')]);
  assert.equal(report.actions[1].plugin, 'rdsh-translation');
  assert.deepEqual(report.actions[1].args, ['plugin', '--profile', 'desktop', 'add', join(box.checkout, 'plugins', 'rdsh-translation')]);
  assert.equal(existsSync(box.log), false, 'the Desktop command must not run on --dry-run');
  assert.equal(await readFile(box.profile, 'utf8'), before);
});

test('install forwards to the Desktop command and verify then passes', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const { code, stdout } = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], {
    ...env, DSH_DESKTOP_CLI: command, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(code, 0, stdout);
  const calls = (await readFile(box.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls, [
    ['plugin', '--profile', 'desktop', 'add', join(box.checkout, 'plugins', 'rdsh-settings')],
    ['plugin', '--profile', 'desktop', 'add', join(box.checkout, 'plugins', 'rdsh-translation')],
  ]);
  const verify = await run(['desktop', 'verify', '--json'], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(verify.code, 0, verify.stderr);
  assert.deepEqual(JSON.parse(verify.stdout).missing, []);
});

test('verify requires the default translation plugin alongside settings', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, {
    name: 'dsh-profile-desktop',
    dependencies: { 'rdsh-settings': 'link:/repo/plugins/rdsh-settings' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@local/rdsh-settings'] } },
  });
  const verify = await run(['desktop', 'verify', '--json'], { ...env, DSH_DESKTOP_CLI: command });
  assert.notEqual(verify.code, 0);
  assert.deepEqual(JSON.parse(verify.stdout).missing, ['rdsh-translation']);
});

test('install --compute also attaches the compute bridge', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const { code } = await run(['desktop', 'install', '--compute', '--json', '--plugins-dir', box.checkout], {
    ...env, DSH_DESKTOP_CLI: command, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(code, 0);
  const verify = await run(['desktop', 'verify', '--require', 'rdsh-compute', '--json'], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(verify.code, 0, verify.stderr);
});

test('install and verify refuse an uninitialized Desktop profile', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  const envWithCommand = { ...env, DSH_DESKTOP_CLI: command };
  const install = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], envWithCommand);
  assert.notEqual(install.code, 0);
  assert.match(install.stderr, /Open DeepSeek Harness Desktop once/);
  const verify = await run(['desktop', 'verify', '--json'], envWithCommand);
  assert.notEqual(verify.code, 0);
  assert.deepEqual(JSON.parse(verify.stdout).missing, ['rdsh-settings', 'rdsh-translation']);
});

test('a --plugins-dir without the plugins is skipped for a real checkout', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const { code, stdout } = await run(['desktop', 'install', '--dry-run', '--json', '--plugins-dir', join(box.root, 'nope')], {
    ...env, DSH_DESKTOP_CLI: command,
  });
  assert.equal(code, 0, stdout);
  const report = JSON.parse(stdout);
  const resolved = report.plugins_dir;
  assert.notEqual(resolved, join(box.root, 'nope'));
  assert.match(resolved, /plugins$/);
  assert.equal(existsSync(join(resolved, 'rdsh-settings', 'package.json')), true);
});

test('the packaged app layout is discovered without DSH_DESKTOP_CLI', async (t) => {
  const { box, env } = await baseEnv(t);
  // <app>/resources/runtime/cli/bin/dsh[.cmd] is the installed layout the
  // detection must find, so the stub is written exactly there.
  const app = join(box.root, 'DeepSeek Harness');
  const launcher = await stubCommand(box, join(app, 'resources', 'runtime', 'cli', 'bin'));
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const appEnv = { ...env, DSH_DESKTOP_APP_DIR: app };

  const status = await run(['desktop', 'status', '--json'], appEnv);
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.app.path, app);
  assert.equal(report.command.source, 'detected');
  assert.equal(report.command.path, launcher);

  const install = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], {
    ...appEnv, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(install.code, 0, install.stderr);
  assert.equal(JSON.parse((await readFile(box.log, 'utf8')).trim().split('\n')[0])[0], 'plugin');
});

test('the stub launcher matches the host platform', async (t) => {
  const { box } = await baseEnv(t);
  const command = await stubCommand(box);
  assert.equal(command.endsWith(windows ? 'dsh.cmd' : 'dsh'), true);
  assert.equal(existsSync(join(box.root, 'desktop cli', 'stub.cjs')), true);
});

test('Desktop install honors saved sound and gitview feature vetoes', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  for (const feature of ['sound', 'gitview']) {
    const off = await run(['features', 'off', feature], env);
    assert.equal(off.code, 0, off.stderr);
  }
  const result = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], {
    ...env, DSH_DESKTOP_CLI: command, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(result.code, 0, result.stderr);
  const calls = (await readFile(box.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][4].endsWith('rdsh-settings'), true);
});

test('the Desktop installer script carries each saved feature veto into its package list', async (t) => {
  for (const [disabled, enabled] of [['sound', 'gitview'], ['gitview', 'sound']]) {
    const { box, env } = await baseEnv(t);
    const off = await run(['features', 'off', disabled], env);
    assert.equal(off.code, 0, off.stderr);
    const { stdout, stderr } = await exec('sh', [join(repo, 'plugins/install.sh')], {
      cwd: repo,
      env: {
        ...process.env, ...env, HOME: box.root, PROFILE: 'desktop', DRY_RUN: '1', RDSH_BIN: bin,
      },
    });
    const vetoed = disabled === 'sound' ? 'dsh-sound-notifications' : 'dsh-gitview';
    const retained = enabled === 'sound' ? 'dsh-sound-notifications' : 'dsh-gitview';
    assert.doesNotMatch(stdout + stderr, new RegExp(vetoed));
    assert.match(stdout, new RegExp(retained));
  }
});

test('a relative extracted runtime survives the plugin working directory', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const { box, env } = await baseEnv(t);
  await stubCommand(box, join(box.root, 'squashfs-root', 'resources', 'runtime', 'cli', 'bin'));
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const result = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], {
    ...env, HOME: join(box.root, 'isolated-home'), DSH_DESKTOP_CLI: '', DSH_DESKTOP_APP_DIR: '', APPDIR: '',
    STUB_LOG: box.log, STUB_PROFILE: box.profile,
  }, box.root);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal((await readFile(box.log, 'utf8')).trim().split('\n').length, 3);
});

test('a PATH symlink discovers a Desktop runtime outside standard app locations', { skip: windows }, async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box, join(box.root, 'custom-app', 'resources', 'runtime', 'cli', 'bin'));
  const alias = join(box.root, 'bin');
  await mkdir(alias);
  const launcher = join(alias, 'dsh');
  await symlink(command, launcher);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const result = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], {
    ...env, HOME: join(box.root, 'isolated-home'), DSH_DESKTOP_CLI: '', DSH_DESKTOP_APP_DIR: '', APPDIR: '',
    PATH: alias + delimiter + process.env.PATH, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal((await readFile(box.log, 'utf8')).trim().split('\n').length, 3);
});

test('the plugin installer defaults browser packages only for web and desktop', { skip: windows }, async (t) => {
  const { box, env } = await baseEnv(t);
  for (const profile of ['', 'headless', 'tui', 'web', 'desktop']) {
    const { stdout } = await exec('sh', [join(repo, 'plugins/install.sh')], {
      cwd: repo, env: { ...process.env, ...env, HOME: box.root, PROFILE: profile, DRY_RUN: '1', SOUND: '', GITVIEW: '', RDSH_BIN: bin },
    });
    for (const name of ['dsh-sound-notifications', 'dsh-gitview'])
      assert.equal(stdout.includes('github:' + (name === 'dsh-gitview' ? 'yugapor/' : 'cwd514/') + name), ['web', 'desktop'].includes(profile), profile || 'default');
  }
  const { stdout } = await exec('sh', [join(repo, 'plugins/install.sh')], {
    cwd: repo, env: { ...process.env, ...env, HOME: box.root, PROFILE: 'tui', DRY_RUN: '1', SOUND: '1', GITVIEW: '1' },
  });
  assert.match(stdout, /github:cwd514\/dsh-sound-notifications/);
  assert.match(stdout, /github:yugapor\/dsh-gitview/);
});
