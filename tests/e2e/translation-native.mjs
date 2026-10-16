// Optional installed-DSH acceptance: real AgentLoop, LlmRuntime, Session and
// CommandRuntime; only the provider adapter returns deterministic local text.
// No provider SDK, credentials, model API, Web UI or user profile is loaded.
//
// RDSH_NATIVE_MODULES=<isolated DSH node_modules> \
//   node tests/e2e/translation-native.mjs
// A passing run proves native contracts only; browser acceptance is separate.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, '../../plugins/rdsh-translation/index.js');
assert.ok(existsSync(plugin), 'rdsh-translation plugin must exist');
assert.ok(process.env.RDSH_NATIVE_MODULES, 'Set RDSH_NATIVE_MODULES to an isolated installed DSH node_modules');
const modules = resolve(process.env.RDSH_NATIVE_MODULES);
const load = (name) => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);

const home = mkdtempSync(join(tmpdir(), 'rdsh-translation-native-'));
const previousCwd = process.cwd();
const isolated = {
  HOME: home,
  USERPROFILE: home,
  DSH_HOME: join(home, 'dsh'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
};
const previousEnv = new Map(Object.keys(isolated).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(isolated)) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.chdir(home);

const ORIGINAL = 'The answer is ready.';
const TRANSLATED = '回答の準備ができました。';
const SEED_ROUTE = { provider: 'unregistered-seed-provider', model: 'seed-model' };
const CURRENT_ROUTE = { provider: 'translation-stub-provider', model: 'current-model' };
const record = { calls: [], waterfall: [], errors: [] };
let ctx;

async function deadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded 20 seconds`)), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function snapshot(session) {
  const events = structuredClone(session.snapshotEvents());
  return {
    events,
    assistant: events.filter((event) => event.type === 'assistant/message'),
    turns: events.filter((event) => event.type.startsWith('turn/')),
    surface: {
      nodes: [...session.surface.nodes],
      replaceGeneration: session.surface.replaceGeneration,
      contentGeneration: session.surface.contentGeneration,
    },
    messages: structuredClone(session.deriveMessages()),
    header: structuredClone(session.requestHeader()),
  };
}

try {
  const [
    { Context },
    { AgentRegistry },
    { SessionStore },
    { SessionProjectionRegistry },
    { SystemPrompt },
    { ToolRuntime },
    { LlmRuntime, LlmAdapter, createUserMessage, isAgentLoopRequest },
    { AgentLoop },
    { CommandRuntime },
  ] = await Promise.all([
    'cordis', 'dsh-agent', 'dsh-session', 'dsh-session-projection',
    'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-agent-loop', 'dsh-commands',
  ].map(load));
  const { apply: applyTranslation } = await import(pathToFileURL(plugin).href);

  ctx = new Context();
  new AgentRegistry(ctx);
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  const llm = new LlmRuntime(ctx);
  const commands = new CommandRuntime(ctx);

  // Resolve a route different from the immutable initial AgentOptions through
  // the real public waterfall. A plugin using agent.options instead of the
  // latest request/header would reach an unregistered adapter and fail.
  ctx.on('agent/request', async (_position, next) => ({ ...await next(), ...CURRENT_ROUTE }));
  ctx.on('agent/error', ({ error }) => record.errors.push(String(error?.message ?? error)));
  ctx.on('llm/stream', (options, next) => {
    record.waterfall.push({
      provider: options.provider,
      model: options.model,
      loopBuilt: isAgentLoopRequest(options),
    });
    return next();
  });
  llm.registerAdapter([CURRENT_ROUTE.provider], new (class extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: 'Translation native acceptance stub' };
    }
    async *stream(options) {
      record.calls.push({
        provider: options.provider,
        model: options.model,
        messages: structuredClone(options.messages),
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      });
      const text = record.calls.length === 1 ? ORIGINAL : TRANSLATED;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  })());

  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 10 });
  applyTranslation(ctx);
  const agent = await loop.create('translation-native-acceptance', SEED_ROUTE);
  assert.equal(commands.find(agent, 'ja-preview')?.recordInput, false, 'real command registration must suppress model-visible input');
  agent.followup(createUserMessage({
    source: { kind: 'human' },
    content: [{ type: 'text', text: 'Please provide the acceptance answer.' }],
  }));
  await deadline(agent.whenIdle(), 'initial native turn');
  assert.equal(agent.status, 'idle');
  assert.deepEqual(record.errors, []);
  assert.equal(record.calls.length, 1, 'the initial answer must come from one real loop request');

  const before = snapshot(agent.session);
  assert.equal(before.assistant.length, 1, 'the real session must contain the initial assistant answer');
  const answer = before.assistant[0];
  assert.equal(answer.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'), ORIGINAL);
  assert.ok(before.surface.nodes.includes(answer.seq), 'the answer must be on the real current surface');
  assert.ok(before.turns.some((event) => event.type === 'turn/end' && event.data.turn === answer.data.turn && event.data.reason.kind === 'completed'));
  assert.equal(before.header.config.provider, CURRENT_ROUTE.provider);
  assert.equal(before.header.config.model, CURRENT_ROUTE.model);
  assert.equal(agent.options.provider, SEED_ROUTE.provider);
  assert.equal(agent.options.model, SEED_ROUTE.model);

  // This is the public native CommandRuntime endpoint, not the plugin handler
  // called directly. The Web Host separately resolves sessionId to this agent.
  const execution = await deadline(commands.execute(
    agent, `/ja-preview ${answer.data.message.id}`, [], new AbortController().signal,
  ), 'native translation command');
  assert.deepEqual(execution?.result, { kind: 'success', text: TRANSLATED });
  assert.equal(record.calls.length, 2, 'translation must add exactly one independent LLM call');
  const translatedCall = record.calls[1];
  assert.equal(translatedCall.provider, CURRENT_ROUTE.provider);
  assert.equal(translatedCall.model, CURRENT_ROUTE.model);
  assert.equal(translatedCall.messages.length, 1, 'translation input must be independent of conversation history');
  assert.equal(translatedCall.messages[0].role, 'user');
  assert.equal(translatedCall.messages[0].content.length, 1);
  assert.equal(translatedCall.messages[0].content[0].type, 'text');
  assert.ok(translatedCall.messages[0].content[0].text.includes(ORIGINAL));
  assert.ok(!translatedCall.messages[0].content[0].text.includes('Please provide the acceptance answer.'));
  assert.equal(translatedCall.temperature, 0);
  assert.equal(translatedCall.maxTokens, 8192);
  assert.deepEqual(record.waterfall.map(({ loopBuilt }) => loopBuilt), [true, false], 'the real llm/stream waterfall must observe one loop request and one independent preview request');

  const after = snapshot(agent.session);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events, 'existing session events must remain byte-for-byte equivalent');
  assert.deepEqual(after.assistant, before.assistant, 'original assistant messages must remain unchanged');
  assert.deepEqual(after.turns, before.turns, 'preview must not add or change turn events');
  assert.deepEqual(after.surface, before.surface, 'preview must not append, replace or project the model-visible surface');
  assert.deepEqual(after.messages, before.messages, 'deriveMessages for the next request must remain unchanged');
  assert.deepEqual(after.header, before.header, 'preview must not change the request route header');
  const appended = after.events.slice(before.events.length);
  assert.deepEqual(appended.map((event) => event.type), ['command/run', 'command/done']);
  assert.equal(appended[0].data.name, 'ja-preview');
  assert.equal(Object.hasOwn(appended[0].data, 'args'), false, 'recordInput:false must be honored by the real command runtime');
  assert.equal(appended[0].data.commandId, execution.commandId);
  assert.equal(appended[1].data.commandId, execution.commandId);
  assert.equal(appended[1].data.kind, 'success');
  assert.equal(appended[1].data.text, TRANSLATED);
  assert.deepEqual(record.errors, []);
  assert.equal(agent.status, 'idle');

  console.log(JSON.stringify({
    result: 'PASS',
    scope: 'Installed DSH native contracts; local stub adapter; Web UI not covered',
    modelCalls: record.calls.length,
    translationCalls: record.calls.length - 1,
    route: CURRENT_ROUTE,
    originalAnswerUnchanged: true,
    assistantAndTurnEventsUnchanged: true,
    surfaceUnchanged: true,
    deriveMessagesUnchanged: true,
    appendedEventTypes: appended.map((event) => event.type),
    commandResult: execution.result,
    errors: record.errors,
  }, null, 2));
} finally {
  try {
    if (ctx) await ctx.fiber.dispose();
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}
