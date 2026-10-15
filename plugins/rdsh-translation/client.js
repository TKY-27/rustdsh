window.__ModuleLoader__.load({
  id: 'rdsh-translation',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let thresholdPromise;
    function threshold() {
      return thresholdPromise ||= fetch('/api/rdsh-translation/config', { cache: 'no-store' })
        .then(async (response) => { const value = await response.json(); return response.ok && value?.ok && typeof value.kana_threshold === 'number' && Number.isFinite(value.kana_threshold) ? Math.min(0.5, Math.max(0.01, value.kana_threshold)) : 0.08; })
        .catch(() => 0.08);
    }
    function eligible(data, messageId, limit) {
      const final = data?.finalNode;
      if (data?.status !== 'settled' || !final || final.messageId !== messageId || final.interrupted || !Array.isArray(final.blocks) || final.blocks.some((b) => !b || !['text', 'reasoning'].includes(b.kind))) return false;
      let kana = 0, lexical = 0, fence;
      for (const line of final.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').split('\n')) {
        const content = line.replace(/^(?: {0,3}>[ \t]?)+/u, '');
        const open = content.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
        if (!fence && open) { fence = open; continue; }
        if (fence) { const close = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1]; if (close && close[0] === fence[0] && close.length >= fence.length) fence = undefined; continue; }
        if (/^(?: {4}|\t)/u.test(content)) continue;
        for (const char of content) { if (/[\p{L}\p{N}]/u.test(char)) lexical++; if (/[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9d]/u.test(char)) kana++; }
      }
      return lexical > 0 && kana / lexical < limit;
    }
    function TranslateAction(props) {
      const data = props.useChat((snapshot) => [...snapshot.nodes.values()].find((node) => node.kind === 'assistant-step' && node.data?.finalNode?.messageId === props.messageId)?.data);
      const [limit, setLimit] = React.useState(null);
      const [state, setState] = React.useState(null);
      const preview = React.useRef(null);
      const active = React.useRef({ messageId: props.messageId, pending: null });
      if (active.current.messageId !== props.messageId) active.current = { messageId: props.messageId, pending: null };
      React.useEffect(() => { let mounted = true; threshold().then((value) => { if (mounted) setLimit(value); }); return () => { mounted = false; active.current.pending = null; }; }, []);
      React.useEffect(() => {
        if (state?.messageId === props.messageId && (state.text || state.error) && preview.current && !preview.current.open) preview.current.showModal();
      }, [state, props.messageId]);
      if (limit === null || !eligible(data, props.messageId, limit)) return null;
      const view = state?.messageId === props.messageId ? state : null;
      const run = async () => {
        if (active.current.pending) return;
        const request = { messageId: props.messageId };
        active.current.pending = request;
        setState({ messageId: props.messageId, busy: true });
        const settle = (value) => { if (active.current.pending === request && active.current.messageId === request.messageId) setState({ messageId: request.messageId, ...value }); };
        try {
          const response = await props.execute(request.messageId);
          if (!response?.ok) throw new Error('和訳コマンドを実行できませんでした。再試行してください');
          const result = response.value?.result;
          if (result?.kind !== 'success' || typeof result.text !== 'string' || !result.text.trim()) {
            settle({ error: result?.kind === 'error' && typeof result.text === 'string' ? result.text : '和訳結果を受け取れませんでした。再試行してください' });
          } else settle({ text: result.text });
        } catch { settle({ error: '和訳コマンドを実行できませんでした。再試行してください' }); }
        finally { if (active.current.pending === request) active.current.pending = null; }
      };
      return h('div', { className: 'rdsh-translation-preview', style: { maxWidth: '100%', minWidth: 0 } },
        h('button', { type: 'button', disabled: Boolean(view?.busy), onClick: run, 'aria-label': '回答の日本語訳を表示', 'data-testid': 'rdsh-translate-action', style: { cursor: view?.busy ? 'wait' : 'pointer', font: 'inherit' } }, view?.busy ? '和訳中…' : view?.text ? 'もう一度和訳する' : '日本語訳を表示'),
        view?.busy ? h('span', { role: 'status', 'aria-live': 'polite' }, ' 翻訳しています…') : null,
        view?.text || view?.error ? h('dialog', { ref: preview, 'aria-label': '回答の日本語訳', style: { width: 'min(42rem, calc(100vw - 3rem))', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', padding: 16, border: '1px solid currentColor', borderRadius: 8, font: 'inherit' } },
          h('button', { type: 'button', onClick: () => preview.current?.close(), style: { float: 'right', font: 'inherit' } }, '閉じる'),
          view.error ? h('p', { role: 'alert' }, view.error) : h('section', { 'aria-label': '日本語訳（表示のみ）' },
            h('strong', null, '日本語訳'), h('p', { style: { fontSize: '0.85em' } }, '原文と会話履歴は変更していません。訳文はこの画面でのみ表示します。'),
            h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', marginBottom: 0 } }, view.text))) : null);
    }
    return { inject: ['slots', 'remote', 'remote.commands'], apply(ctx) {
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'rdsh-translation-preview', order: 35,
        inject: (sessionId) => ({ execute: (messageId) => ctx.remote.commands.execute(sessionId, `/ja-preview ${messageId}`, []) }) }, TranslateAction));
    } };
  },
});
