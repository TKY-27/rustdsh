import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access } from 'node:fs/promises';
import { createAgySdkBackend, createPythonRunner } from './agy-sdk.mjs';
import { assertSdkChildCleanup, assertSdkStartCleanup } from './sdk-cleanup-fixture.mjs';

test('Python runner removes isolated workspace and store after child completion or SIGKILL', t =>
  assertSdkChildCleanup(t, createPythonRunner, { operation: 'generate' }));
test('Python runner cleans startup failures and waits for close before cleanup', t =>
  assertSdkStartCleanup(t, createPythonRunner));
test('SDK bridge receives projected history and no native tools', async () => {
  let received;
  const backend = createAgySdkBackend({ runner: async payload => {
    received = payload;
    return { text: JSON.stringify({ version: 1, text: '', toolCalls: [{ id: 'one', name: 'read', arguments: { path: 'a' } }] }) };
  } });
  const result = await backend.generate({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect fixture' }] }], tools: [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
  assert.equal(received.operation, 'generate');
  assert.equal(received.tools, undefined);
  assert.match(received.prompt, /inspect fixture/);
  assert.match(received.prompt, /read/);
  assert.equal(result.toolCalls[0].name, 'read');
});
test('SDK response cannot request undeclared tools', async () => {
  const backend = createAgySdkBackend({ runner: async () => ({ text: JSON.stringify({ version: 1, text: '', toolCalls: [{ id: 'bad', name: 'shell', arguments: {} }] }) }) });
  await assert.rejects(backend.generate({ messages: [{ role: 'user', content: 'hi' }] }));
});
test('SDK catalog comes from runner, never guesses availability', async () => {
  const backend = createAgySdkBackend({ runner: async () => ({ models: [{ id: 'sdk-default', name: 'SDK default' }] }) });
  assert.deepEqual(await backend.discover(), [{ id: 'sdk-default', name: 'SDK default' }]);
  await assert.rejects(createAgySdkBackend({ runner: async () => ({}) }).discover(), /invalid model catalog/);
});
test('already aborted requests do not spawn Python', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPythonRunner({ spawnImpl: () => { throw new Error('must not spawn'); } })({}, { signal: controller.signal }), /aborted/);
});
test('resolved key is passed only through child environment', async () => {
  let request, settings;
  const backend = createAgySdkBackend({ keyResolver: async () => 'mock-private-key', runner: async (payload, options) => {
    request = payload; settings = options;
    return { text: '{"version":1,"text":"ok","toolCalls":[]}' };
  } });
  await backend.generate({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(JSON.stringify(request).includes('mock-private-key'), false);
  assert.equal(settings.env.GEMINI_API_KEY, 'mock-private-key');
});
test('repairs invalid JSON once, using fresh history projection', async () => {
  const prompts = [];
  const backend = createAgySdkBackend({ runner: async payload => {
    prompts.push(payload.prompt);
    return { text: prompts.length === 1 ? 'invalid' : '{"version":1,"text":"fixed","toolCalls":[]}' };
  } });
  assert.equal((await backend.generate({ messages: [{ role: 'user', content: 'original history' }] })).text, 'fixed');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /failed validation/);
  assert.match(prompts[1], /original history/);
});
test('transport failure never triggers JSON repair', async () => {
  let attempts = 0;
  const backend = createAgySdkBackend({ runner: async () => { attempts++; throw new Error('SDK_REQUEST_FAILED'); } });
  await assert.rejects(backend.generate({ messages: [{ role: 'user', content: 'hello' }] }), /SDK_REQUEST_FAILED/);
  assert.equal(attempts, 1);
});

function pythonSpawnFixture() {
  const state = {};
  state.spawnImpl = (file, args, settings) => {
    state.file = file; state.args = args; state.settings = settings;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => process.nextTick(() => {
      child.stdout.write('{"models":[{"id":"synthetic"}]}');
      child.emit('close', 0);
    }));
    return child;
  };
  return state;
}

test('Python child excludes unrelated ambient credentials and code injection settings', async () => {
  process.env.RDSH_PR591_UNRELATED_SECRET = 'synthetic-unrelated-value';
  process.env.NODE_OPTIONS = '--synthetic-option-not-executed';
  try {
    const state = pythonSpawnFixture();
    await createPythonRunner({ python: 'synthetic-python-only', spawnImpl: state.spawnImpl })({ operation: 'discover' });
    assert.equal(Object.hasOwn(state.settings.env, 'RDSH_PR591_UNRELATED_SECRET'), false);
    assert.equal(Object.hasOwn(state.settings.env, 'NODE_OPTIONS'), false);
    assert.equal(state.file, 'synthetic-python-only');
    assert.equal(state.args[0], '-I');
  } finally {
    delete process.env.RDSH_PR591_UNRELATED_SECRET;
    delete process.env.NODE_OPTIONS;
  }
});

test('Python child retains only runtime and explicit Google auth settings from base and request', async () => {
  const state = pythonSpawnFixture();
  const env = { HOME: '/synthetic-home', PATH: '/synthetic-bin', GOOGLE_GENAI_USE_ENTERPRISE: 'True',
    GOOGLE_CLOUD_PROJECT: 'synthetic-project', GOOGLE_CLOUD_LOCATION: 'synthetic-location',
    GOOGLE_APPLICATION_CREDENTIALS: '/synthetic-home/adc.json', OTHER_API_KEY: 'unrelated', PYTHONPATH: '/injection' };
  await createPythonRunner({ python: 'synthetic-python-only', spawnImpl: state.spawnImpl, env })({ operation: 'generate' }, {
    env: { GEMINI_API_KEY: 'resolved-synthetic-key', GOOGLE_API_KEY: 'resolved-synthetic-key', OTHER_TOKEN: 'unrelated', PYTHONPATH: '/request-injection' },
  });
  const { RDSH_SDK_TMPDIR: root, ...childEnv } = state.settings.env;
  await assert.rejects(access(root), { code: 'ENOENT' });
  assert.deepEqual(childEnv, { HOME: '/synthetic-home', PATH: '/synthetic-bin',
    GEMINI_API_KEY: 'resolved-synthetic-key', GOOGLE_API_KEY: 'resolved-synthetic-key',
    GOOGLE_GENAI_USE_ENTERPRISE: 'True', GOOGLE_CLOUD_PROJECT: 'synthetic-project', GOOGLE_CLOUD_LOCATION: 'synthetic-location',
    GOOGLE_APPLICATION_CREDENTIALS: '/synthetic-home/adc.json' });
});

test('Antigravity rejects unsupported generation controls before key resolution or runner calls', async () => {
  let keys = 0, calls = 0;
  const backend = createAgySdkBackend({ keyResolver: async () => { keys++; return 'synthetic-key'; },
    runner: async () => { calls++; return { text: '{"version":1,"text":"ok","toolCalls":[]}' }; } });
  for (const options of [{ temperature: 0 }, { maxTokens: 1 }, { stop: [] }, { stop: ['END'] }, { temperature: null }])
    await assert.rejects(backend.generate({ model: 'synthetic', ...options }), { code: 'UNSUPPORTED_GENERATION_OPTION' });
  assert.equal(keys, 0); assert.equal(calls, 0);
});
