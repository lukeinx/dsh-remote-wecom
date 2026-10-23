// DeepSeek Harness side of the remote: typertGateway calls, session/event translation and the
// approval / user-question answerers. Listeners live as long as the plugin; the remote behind
// getRemote() is replaced on restart, so every entry point re-reads it.
import crypto from 'node:crypto';

// Desktop's own answerer reports "no window" by settling at once; a later empty answer is a real dismissal.
const NATIVE_IMMEDIATE_MS = 1500;
const SNAPSHOT_MAX_MESSAGES = 1000;
const SNAPSHOT_TIMEOUT_MS = 10000;

const textOf = content => Array.isArray(content)
  ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
  : typeof content === 'string' ? content.trim() : '';

/** session/list 条目 / api-session/added 摘要 → core 的会话信息。 */
export function sessionInfo(s) {
  const v = s?.projections?.values ?? {};
  return {
    sessionId: s.sessionId, updatedAt: Number(s.updatedAt) || 0, cwd: s.cwd || '',
    agentAvailable: !!s.agentAvailable, running: !!s.running, blank: !!s.blank,
    sub: s.origin === 'subagent' || s.origin?.kind === 'subagent' || !!s.parentSessionId,
    title: typeof v.title === 'string' ? v.title : '',
    prompts: (Array.isArray(v.turnOutline) ? v.turnOutline : []).map(x => x?.prompt).filter(x => typeof x === 'string'),
  };
}

const sessionIdOf = req => {
  const id = req?.agent?.session?.id ?? req?.agent?.id;
  return typeof id === 'string' ? id : '';
};

export function createDshHost(ctx, getRemote) {
  const peer = ctx.connection.createPeer({principal: {kind: 'owner'}, interactions: 'none'});
  const invoke = (namespace, method, args) => ctx.typertGateway.invoke({namespace, method, args, peer});
  const accepted = (r, what) => { if (r?.accepted === false) throw new Error(`${what} 未被接受${r.reason ? `：${r.reason}` : ''}`); return r; };
  const live = () => { const r = getRemote(); return r && !r.stopped ? r : null; };

  const host = {
    async listSessions() {
      const r = await invoke('session', 'list', {_request: {}});
      return (r?.items ?? []).filter(s => typeof s?.sessionId === 'string').map(sessionInfo);
    },
    async projections(sessionId) {
      const r = await invoke('session', 'projections', {request: {sessionId}});
      return r?.values ?? null;
    },
    async createSession(cwd) {
      const r = await invoke('session', 'create', {request: {cwd}});
      if (typeof r?.sessionId !== 'string') throw new Error('session/create 没有返回 sessionId');
      return r.sessionId;
    },
    async prompt(sessionId, requestId, text) {
      accepted(await invoke('session', 'prompt', {request: {requestId, sessionId, mode: 'queue', content: [{type: 'text', text}]}}), '消息');
    },
    async cancel(sessionId) {
      accepted(await invoke('session', 'cancel', {request: {sessionId}}), '中断请求');
    },
    modelCatalog() { return invoke('session', 'modelCatalog', {}); },
    async selectModel(sessionId, sel) {
      const r = await invoke('session', 'selectModel', {request: {sessionId, ...sel}});
      return r?.selected ?? r;
    },
    // rc.2 的 /compact 不接受参数。
    async compact(sessionId) {
      const r = await invoke('commands', 'execute', {agentId: sessionId, line: '/compact', submittedAttachments: []});
      return r?.result ?? r;
    },
    /** session/follow 首帧快照里的事件（最近 SNAPSHOT_MAX_MESSAGES 条消息范围内）。 */
    async snapshot(sessionId) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('session/follow 超时')), SNAPSHOT_TIMEOUT_MS);
      try {
        const it = await ctx.typertGateway.stream({namespace: 'session', method: 'follow', peer, signal: ac.signal,
          args: {request: {address: {kind: 'session', sessionId}, maxMessages: SNAPSHOT_MAX_MESSAGES}}});
        for await (const frame of it) {
          if (frame?.type !== 'snapshot') continue;
          return (frame.records ?? []).filter(x => x?.type === 'event' && x.event).map(x => x.event);
        }
        return [];
      } finally {
        clearTimeout(timer);
        ac.abort();
      }
    },
  };

  // 一轮的来源看 turn/start 之后第一条 source.kind === 'user' 的用户消息；没有用户消息的轮次按电脑发起。
  const opening = new Set();
  const begin = (r, sid, rpcId = '', text = '') => {
    if (!opening.delete(sid)) return;
    r.turnBegin(sid, {rpcId: typeof rpcId === 'string' ? rpcId : '', text});
  };
  ctx.on('session/event', (session, event) => {
    const r = live();
    const sid = session?.id;
    if (!r || typeof sid !== 'string' || typeof event?.type !== 'string') return;
    const d = event.data ?? {};
    switch (event.type) {
      case 'turn/start': opening.add(sid); break;
      case 'user/message':
        if (d.source?.kind === 'user') begin(r, sid, d.source.rpcId, textOf(d.content));
        break;
      case 'assistant/message':
        begin(r, sid);
        r.output(sid, textOf(d.message?.content));
        break;
      case 'tool/call':
        begin(r, sid);
        r.activity(sid, d.name);
        break;
      case 'turn/end':
        if (opening.delete(sid)) break;
        r.turnEnd(sid, {kind: d.reason?.kind, error: d.reason?.error?.message});
        break;
      case 'session/title':
        if (typeof d.title === 'string') r.title(sid, d.title, d.source?.kind !== 'fallback');
        break;
      case 'model/selection': r.modelSelected(sid, d); break;
    }
    r.ingest(sid, event);
  }, {global: true});
  ctx.on('api-session/added', summary => { if (summary?.sessionId) live()?.sessionSeen(sessionInfo(summary)); }, {global: true});
  ctx.on('api-session/removed', sid => { opening.delete(sid); live()?.sessionGone(sid); }, {global: true});
  ctx.on('api-session/status', (sid, running) => live()?.sessionStatus(sid, running), {global: true});

  /**
   * 与 Desktop 窗口抢答：同时调 next()，谁先答用谁的。req.signal 换成私有的，
   * 手机先答时只收回 Desktop 那一个弹窗，不影响这一轮。
   */
  async function race(req, next, handle, {decided, fromPhone, cancelled, fallback}) {
    const turnSignal = req.signal;
    const lifetime = new AbortController();
    const relay = () => lifetime.abort(turnSignal.reason);
    turnSignal?.addEventListener('abort', relay, {once: true});
    req.signal = lifetime.signal;
    const t0 = Date.now();
    const nativeP = Promise.resolve().then(() => next()).then(v => ({kind: 'native', v, at: Date.now()}), e => ({kind: 'native', e, at: Date.now()}));
    const phoneP = handle.answer.then(a => ({kind: 'phone', a}));
    const abortP = new Promise(res => {
      if (turnSignal?.aborted) res({kind: 'abort'});
      turnSignal?.addEventListener('abort', () => res({kind: 'abort'}), {once: true});
    });
    const counts = n => !n.e && decided(n.v, n.at - t0 >= NATIVE_IMMEDIATE_MS);
    try {
      let won = await Promise.race([nativeP, phoneP, abortP]);
      if (won.kind === 'native' && !counts(won)) won = await Promise.race([phoneP, abortP]);
      if (won.kind === 'phone' && won.a?.detached) {
        const n = await nativeP;
        if (n.e) throw n.e;
        return n.v ?? fallback;
      }
      if (won.kind === 'phone') {
        lifetime.abort(new Error('answered on phone'));
        return fromPhone(won.a);
      }
      handle.done();
      if (won.kind === 'abort') return cancelled;
      if (won.e) throw won.e;
      return won.v;
    } finally {
      turnSignal?.removeEventListener('abort', relay);
      if (req.signal === lifetime.signal) req.signal = turnSignal;
    }
  }

  ctx.on('approval/request', async (req, next) => {
    const r = live();
    const sid = sessionIdOf(req);
    if (!r || !sid || req?.signal?.aborted) return next();
    const tool = String(req.toolName || '');
    const handle = r.uiAsk(sid, {
      kind: 'confirm', reqId: `ap-${crypto.randomUUID()}`,
      title: req.displayReason?.zh || req.reason || `允许使用工具 ${tool}`,
      message: tool ? `工具：${tool}` : '',
    });
    if (!handle) return next();
    return race(req, next, handle, {
      decided: v => v === 'allowed-once' || v === 'rejected',
      fromPhone: a => a.confirmed === true ? 'allowed-once' : a.confirmed === false ? 'rejected' : 'cancelled',
      cancelled: 'cancelled',
      fallback: 'unavailable',
    });
  }, {global: true, prepend: true});

  /** 手机的开放式回答 → DSH answer item；取消、超时都是未回答。 */
  const answerItem = (q, a) => {
    if (a?.custom) return {id: q.id, selected: [], custom: String(a.value ?? '')};
    if (Array.isArray(a?.values)) return {id: q.id, selected: a.values.map(String)};
    if (a?.value !== undefined) return {id: q.id, selected: [String(a.value)]};
    return {id: q.id, selected: []};
  };
  ctx.on('user-questions/request', async (req, next) => {
    const r = live();
    const sid = sessionIdOf(req);
    const qs = Array.isArray(req?.questions) ? req.questions.filter(q => typeof q?.id === 'string') : [];
    if (!r || !sid || !qs.length || req?.signal?.aborted) return next();
    const ask = (q, i) => {
      const opts = Array.isArray(q.options) ? q.options.filter(o => typeof o?.label === 'string') : [];
      return r.uiAsk(sid, {
        kind: 'question', reqId: `uq-${crypto.randomUUID()}`,
        title: `${qs.length > 1 ? `（${i + 1}/${qs.length}）` : ''}${String(q.question || q.header || '需要回答')}`,
        message: typeof q.detail === 'string' ? q.detail : '',
        header: typeof q.header === 'string' ? q.header : '',
        options: opts.map(o => o.label), descriptions: opts.map(o => o.description || ''),
        allowText: true, multi: !!q.multiSelect,
      });
    };
    const first = ask(qs[0], 0);
    if (!first) return next();
    let current = first;
    let gone = false;
    const answer = (async () => {
      const answers = [];
      for (let i = 0; i < qs.length; i++) {
        if (i) current = ask(qs[i], i);
        if (!current || gone) return {detached: true};
        const a = await current.answer;
        if (a?.detached) return a;
        answers.push(answerItem(qs[i], a));
        // 取消即放弃整组，剩下的题按未回答。
        if (a?.cancelled) {
          for (const q of qs.slice(i + 1)) answers.push({id: q.id, selected: []});
          break;
        }
      }
      return {answers};
    })();
    const handle = {answer, done() { gone = true; current?.done(); }};
    return race(req, next, handle, {
      decided: (v, late) => Array.isArray(v?.answers) && (late || v.answers.some(x => x?.selected?.length || x?.custom)),
      fromPhone: a => ({answers: a.answers}),
      cancelled: {answers: []},
      fallback: {answers: []},
    });
  }, {global: true, prepend: true});

  return host;
}
