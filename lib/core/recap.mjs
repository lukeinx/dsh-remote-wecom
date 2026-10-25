// 「回顾」：从 session/follow 快照里取最近一轮已结束的对话。
// 一轮从 turn/start 到 turn/end；提问取第一条 source.kind 为 user（或定时、目标触发）的用户消息，同一轮里的插话不另起一轮。
// 没有任何消息就结束的轮次（如归档会话被拦下）和还没有 turn/end 的进行中轮次跳过。
const PROMPT_KINDS = new Set(['user', 'schedule', 'goal']);
const textOf = (content) => Array.isArray(content)
  ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  : typeof content === 'string' ? content.trim() : '';

/** @returns {{prompt: string, text: string, status: 'done'|'aborted'|'error', startedAt: number, endedAt: number} | null} */
export function lastTurn(events) {
  const sorted = [...(events || [])].filter((e) => typeof e?.type === 'string')
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  let cur = null, done = null;
  for (const ev of sorted) {
    const d = ev.data ?? {};
    const at = Number(ev.time) || 0;
    if (ev.type === 'turn/start') cur = {prompt: '', text: '', messages: 0, startedAt: at};
    else if (ev.type === 'user/message' && PROMPT_KINDS.has(d.source?.kind)) {
      cur ||= {prompt: '', text: '', messages: 0, startedAt: at};
      if (!cur.messages++) cur.prompt = textOf(d.content);
    } else if (ev.type === 'assistant/message') {
      cur ||= {prompt: '', text: '', messages: 0, startedAt: at}; // 快照窗口从这一轮中间开始
      cur.messages++;
      const text = textOf(d.message?.content);
      if (text) cur.text = text;
    } else if (ev.type === 'turn/end' && cur) {
      if (cur.messages) {
        const kind = d.reason?.kind;
        done = {prompt: cur.prompt, text: cur.text, status: kind === 'aborted' ? 'aborted' : kind === 'error' ? 'error' : 'done', startedAt: cur.startedAt, endedAt: at};
      }
      cur = null;
    }
  }
  return done;
}
