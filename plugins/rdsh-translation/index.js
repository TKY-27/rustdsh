import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { normalizeKanaThreshold, protectLiterals, restoreLiterals, buildTranslationPrompt } from './translation-core.js';

export const inject = ['commands', 'llm'];
const MAX_BYTES = 64 * 1024;
class PreviewError extends Error {}
const reject = (text) => { throw new PreviewError(text); };

export async function readSettings() {
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rdsh.json');
    const doc = JSON.parse(await readFile(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) reject('rdsh.jsonの形式を確認してください');
    return { kanaThreshold: normalizeKanaThreshold(doc.translation?.kana_threshold) };
  } catch (error) {
    if (error.code === 'ENOENT') return { kanaThreshold: normalizeKanaThreshold() };
    if (error instanceof PreviewError) throw error;
    reject('rdsh.jsonを読み込めません');
  }
}

export function findAnswer(agent, messageId) {
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(messageId)) reject('対象回答のIDが不正です');
  const events = agent.session.snapshotEvents();
  const event = events.find((item) => item.type === 'assistant/message' && item.data?.message?.id === messageId);
  if (!event || event.data.interrupted || !agent.session.surface.nodes.includes(event.seq)) reject('対象回答を現在の会話から確認できません');
  if (!events.some((item) => item.type === 'turn/end' && item.data?.turn === event.data.turn && item.data?.reason?.kind === 'completed')) {
    reject('完了した回答だけを翻訳できます');
  }
  const blocks = event.data.message.content;
  if (!Array.isArray(blocks) || blocks.some((block) => !block || !['text', 'reasoning'].includes(block.type) || block.type === 'text' && typeof block.text !== 'string')) {
    reject('画像・添付・tool callを含む回答は翻訳できません');
  }
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  if (!text.trim()) reject('対象回答に翻訳できるテキストがありません');
  if (Buffer.byteLength(text) > MAX_BYTES) reject('回答が長すぎるため翻訳できません');
  return { seq: event.seq, text };
}

export function translationRoute(agent) {
  const config = agent.session.requestHeader()?.config || agent.options;
  const provider = config?.provider;
  const model = config?.model;
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) reject('現在のモデルを取得できません');
  return { provider, model };
}

export async function translatePreview({ agent, llm, messageId, signal, timeoutMs = 60000 }) {
  if (agent.status !== 'idle') return { kind: 'error', text: '回答の生成が完了してから翻訳してください' };
  try {
    return await agent.runMaintenance(async (agentSignal) => {
      const target = findAnswer(agent, messageId);
      const route = translationRoute(agent);
      const input = protectLiterals(target.text);
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, agentSignal, controller.signal].filter(Boolean));
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        combined.throwIfAborted();
        let text = '';
        let finish;
        for await (const chunk of llm.stream({ ...route, messages: [{ role: 'user', content: [{ type: 'text', text: buildTranslationPrompt(input.masked, input.literals) }] }], temperature: 0, maxTokens: 8192, signal: combined })) {
          combined.throwIfAborted();
          if (chunk.type === 'text-delta') {
            if (typeof chunk.text !== 'string') reject('和訳結果の形式を確認できません');
            text += chunk.text;
            if (Buffer.byteLength(text) > MAX_BYTES) reject('和訳結果が長すぎるため表示を中止しました');
          }
          if (chunk.type === 'finish') finish = chunk.reason;
        }
        combined.throwIfAborted();
        if (finish?.kind !== 'stop' || !text.trim()) reject('和訳が正常に完了しませんでした。再試行してください');
        const current = findAnswer(agent, messageId);
        if (current.seq !== target.seq || current.text !== target.text) reject('対象回答が変わりました。再試行してください');
        try { return { kind: 'success', text: restoreLiterals(text, input.literals) }; }
        catch { reject('和訳でコード・識別子・パスを保持できなかったため表示を中止しました'); }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    });
  } catch (error) {
    return { kind: 'error', text: error instanceof PreviewError ? error.message : '和訳を完了できませんでした。実行中の処理を確認して再試行してください' };
  }
}

function json(req, res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function registerConfigApi(ctx) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/rdsh-translation/config', handler: async (req, res) => {
    let rejection = 503;
    try { if (typeof ctx.connection?.requestRejection === 'function') rejection = ctx.connection.requestRejection(req); } catch { /* 認証サービス異常時も拒否する */ }
    if (rejection !== undefined) return json(req, res, [401, 403].includes(rejection) ? rejection : 503, { ok: false, error: '認証を確認できません' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(req, res, 405, { ok: false, error: 'この操作は利用できません' });
    try { const settings = await readSettings(); json(req, res, 200, { ok: true, kana_threshold: settings.kanaThreshold }); }
    catch { json(req, res, 400, { ok: false, error: 'rdsh.jsonを確認してください' }); }
  } });
}

export function apply(ctx) {
  return ctx.effect(() => {
    const off = ctx.commands.register({ name: 'ja-preview', description: '回答の日本語訳を表示します（会話履歴は変更しません）', recordInput: false,
      handler: ({ agent, rawInput, signal }) => translatePreview({ agent, llm: ctx.llm, messageId: rawInput.trim(), signal }) });
    const web = ctx.inject(['webServer', 'connection'], registerConfigApi);
    return async () => { off(); await web.dispose(); };
  });
}
