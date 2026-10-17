import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSurface, surfacePath, writeSurface } from '../store.js';

const surface = (id) => ({
  surface_id: id,
  blocks: [{ id: 'text', kind: 'text', data: { text: id } }],
});

const failure = (code) => Object.assign(new Error(`injected ${code}`), { code });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-surface-retry-failures-'));
  t.after(async () => {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  const initial = await writeSurface(root, surface('initial'));
  return { root, initial, target: surfacePath(root) };
}

test('transient EPERM retries one completed temporary file', async (t) => {
  const { root, target } = await fixture(t);
  const rename = fs.rename;
  const calls = [];
  t.mock.method(fs, 'rename', async (from, to) => {
    calls.push([from, to]);
    if (calls.length < 3) throw failure('EPERM');
    return rename(from, to);
  });

  const written = await writeSurface(root, surface('replacement'));

  assert.equal(written.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], calls[2]);
  assert.equal(calls[0][1], target);
  assert.equal((await readSurface(root)).surface.surface_id, 'replacement');
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
});

for (const [code, attempts] of [['EPERM', 6], ['EACCES', 1]]) {
  test(`${code} preserves the destination, cleans its temporary file, and keeps the original error`, async (t) => {
    const { root, initial, target } = await fixture(t);
    const error = failure(code);
    const unlink = fs.unlink;
    const unlinked = [];
    let actualAttempts = 0;
    t.mock.method(fs, 'unlink', async (file) => {
      unlinked.push(file);
      return unlink(file);
    });
    t.mock.method(fs, 'rename', async () => {
      actualAttempts++;
      throw error;
    });

    await assert.rejects(writeSurface(root, surface('replacement')), caught => caught === error);

    assert.equal(actualAttempts, attempts);
    assert.deepEqual((await readSurface(root)).surface, initial.surface);
    assert.equal(unlinked.includes(target), false);
    assert.equal(unlinked.length, 1);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
  });
}
