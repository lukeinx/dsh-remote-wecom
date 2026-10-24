import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : ''

class MockAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Mock' } }
  async listModels(provider) { return [{ provider, id: 'echo', name: 'Echo', inputModalities: ['text', 'image'] }, { provider, id: 'echo2', name: 'Echo 2', inputModalities: ['text'] }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
  }
  async *stream(options) {
    const msgs = options.messages ?? []
    const CTX = /^(\[|<|Time sampled|Current runtime context|Generate the session title)/
    let last = msgs[msgs.length - 1]
    if (last?.role === 'user') last = [...msgs].reverse().find(m => m.role === 'user' && !CTX.test(text(m.content).trim())) ?? last
    const titleAsk = text(msgs[msgs.length - 1]?.content)
    if (/Generate the session title/.test(titleAsk)) {
      // Distinct session names: the first word of the first human message.
      let first = ''
      try { first = JSON.parse(titleAsk.slice(titleAsk.indexOf('\n') + 1))[0]?.text ?? '' } catch {}
      yield* this.say(first.trim().split(/\s+/)[0] || 'Untitled')
      return
    }
    const delay = (ms) => new Promise(r => setTimeout(r, ms))
    if (last?.role === 'user') {
      const t = text(last.content).trim()
      const m = /^\/tool (\S+) (.*)$/s.exec(t)
      if (m) {
        const id = 'call_' + Math.random().toString(36).slice(2, 8)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: m[1], argumentsDelta: m[2] }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: m[1], arguments: m[2] } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const sleep = /^\/sleep (\d+)/.exec(t)
      if (sleep) await new Promise((r, j) => { const t = setTimeout(r, Number(sleep[1])); options.signal?.addEventListener('abort', () => { clearTimeout(t); j(options.signal.reason ?? new Error('aborted')) }) })
      yield* this.say('echo: ' + t)
      return
    }
    yield* this.say('tool done: ' + text(last?.content).slice(0, 200))
  }
  async *say(s) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: s }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: s } }
    yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 5, totalTokens: 1005 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']
export function apply(ctx) { ctx.llm.registerAdapter(['mock'], new MockAdapter()) }
