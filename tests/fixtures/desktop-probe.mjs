// Test-only stand-in for the Desktop window: drives the gateway as the owner over a local HTTP port.
import http from 'node:http'

export const name = 'desktop-probe'
export const inject = ['typertGateway', 'connection']

export function apply(ctx, config) {
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const out = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v ?? null)) }
    try {
      if (req.url !== '/call') return out(404, { error: 'not found' })
      const { ns, method, args = {} } = JSON.parse(body || '{}')
      out(200, await ctx.typertGateway.invoke({ namespace: ns, method, args, peer }))
    } catch (e) { out(500, { error: String(e?.message || e) }) }
  })
  server.listen(config.port, '127.0.0.1')
  ctx.effect(() => () => server.close(), 'desktop probe')
}
