// Real local child only; no SDK, harness, credentials or network is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function assertSdkChildCleanup(t, createRunner, payload) {
  for (const mode of ['success', 'abort', 'timeout', 'output', 'invalid', 'exit']) {
    await t.test(mode, async () => {
      const fixture = await mkdtemp(path.join(tmpdir(), 'rdsh-sdk-cleanup-test-'));
      const marker = path.join(fixture, 'marker.json');
      const sentinel = path.join(fixture, 'keep.txt');
      await writeFile(sentinel, 'existing synthetic data');
      let child, options, childRoot, closed = false;
      let ready;
      const readiness = new Promise(resolve => { ready = resolve; });
      const source = `
        const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
        process.stdin.resume(); process.stdin.on('end', () => {
          const root = fs.mkdtempSync(path.join(process.env.RDSH_SDK_TMPDIR || os.tmpdir(), 'rdsh-fake-sdk-'));
          for (const name of ['workspace', 'store']) { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'synthetic.txt'), 'synthetic'); }
          fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({root}));
          process.stderr.write('ready\\n');
          const mode = ${JSON.stringify(mode)};
          if (mode === 'success') process.stdout.end('{}');
          else if (mode === 'invalid') process.stdout.end('invalid');
          else if (mode === 'exit') process.exitCode = 1;
          else { setInterval(() => {}, 1000); if (mode === 'output') process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1)); }
        });`;
      const spawnImpl = (_file, _args, settings) => {
        options = settings;
        child = spawn(process.execPath, ['-e', source], settings);
        child.stderr.once('data', ready);
        child.once('close', () => { closed = true; });
        return child;
      };
      const controller = new AbortController();
      const promise = createRunner({ spawnImpl, timeoutMs: mode === 'timeout' ? 1000 : 10000,
        env: { HOME: fixture, USERPROFILE: fixture, RDSH_SDK_TMPDIR: fixture } })(payload,
        { signal: controller.signal, env: { RDSH_SDK_TMPDIR: fixture } });
      // Attach rejection immediately so fast failures are never unhandled.
      const result = promise.then(value => ({ value }), error => ({ error }));
      try {
        await readiness;
        childRoot = JSON.parse(await readFile(marker, 'utf8')).root;
        if (mode === 'abort') controller.abort();
        const outcome = await result;
        if (mode === 'success') assert.deepEqual(outcome.value, {});
        else assert.ok(outcome.error, `${mode} must reject`);
        assert.equal(closed, true, 'runner must wait for child close before settling');
        await assert.rejects(access(childRoot), { code: 'ENOENT' });
        assert.ok(options.env.RDSH_SDK_TMPDIR, 'parent provides an owned temp root');
        assert.notEqual(options.env.RDSH_SDK_TMPDIR, fixture, 'ambient/request temp root is ignored');
        await assert.rejects(access(options.env.RDSH_SDK_TMPDIR), { code: 'ENOENT' });
        assert.equal(await readFile(sentinel, 'utf8'), 'existing synthetic data');
      } finally {
        if (!closed) { child?.kill('SIGKILL'); await new Promise(resolve => child?.once('close', resolve)); }
        if (childRoot) await rm(childRoot, { recursive: true, force: true });
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
}

export async function assertSdkStartCleanup(t, createRunner) {
  await t.test('synchronous spawn failure', async () => {
    let root;
    const runner = createRunner({ env: {}, spawnImpl: (_file, _args, settings) => {
      root = settings.env.RDSH_SDK_TMPDIR;
      throw new Error('synthetic spawn failure');
    } });
    await assert.rejects(runner({}), /could not start/);
    await assert.rejects(access(root), { code: 'ENOENT' });
  });
  for (const mode of ['error', 'abort']) await t.test(`${mode} waits for close`, async () => {
    const controller = new AbortController();
    let child, root, settled = false;
    const runner = createRunner({ env: {}, spawnImpl: (_file, _args, settings) => {
      root = settings.env.RDSH_SDK_TMPDIR;
      child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    } });
    const promise = runner({}, { signal: controller.signal });
    const result = promise.then(() => { settled = true; }, () => { settled = true; });
    if (mode === 'error') child.emit('error', new Error('synthetic start failure'));
    else controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await access(root);
    child.emit('close', 1);
    await result;
    await assert.rejects(access(root), { code: 'ENOENT' });
  });
}
