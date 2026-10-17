import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSurface, surfacePath, writeSurface } from '../store.js';

async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-surface-windows-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const surface = (id, text) => ({
  surface_id: id,
  blocks: [{ id: 'text', kind: 'text', data: { text } }],
});

// Emulate the Windows outcome for two concurrent MoveFileExW replacements of
// the same destination: the loser gets ERROR_ACCESS_DENIED, which libuv
// surfaces as EPERM.
test('concurrent replacement survives one Windows-style EPERM', { timeout: 5000 }, async (t) => {
  const dir = await home(t);
  const target = surfacePath(dir);
  const rename = fs.rename;
  let ready = 0;
  let injected = false;
  const { promise, resolve } = Promise.withResolvers();
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === target && !injected) {
      if (++ready === 2) resolve();
      await promise;
      if (!injected) {
        injected = true;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', path: source, dest: destination });
      }
    }
    return rename(source, destination);
  });
  const values = [surface('first', 'a'), surface('second', 'b')];
  const results = await Promise.allSettled(values.map(value => writeSurface(dir, value)));
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
  const loaded = await readSurface(dir);
  assert.equal(loaded.error, null);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
});
