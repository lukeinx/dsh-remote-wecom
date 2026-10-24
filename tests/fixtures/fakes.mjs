// 本机假服务：企微智能机器人 ws 协议与扫码创建机器人接口。e2e 与 scripts/preview.mjs 共用。
import http from 'node:http';
import {WebSocketServer} from 'ws';

/** 每个请求帧都回 errcode 0；记录主动发送的消息。say() 模拟用户单聊发消息。 */
export async function startFakeWeCom({botId = 'test-bot'} = {}) {
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise(r => server.on('listening', r));
  const state = {sent: [], connections: 0, socket: null};
  server.on('connection', w => {
    state.socket = w;
    state.connections++;
    w.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.cmd === 'aibot_send_msg') state.sent.push(frame.body);
      w.send(JSON.stringify({headers: frame.headers, errcode: 0, errmsg: 'ok'}));
    });
  });
  let seq = 0;
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    state,
    say(text, {userid = 'alice', chattype = 'single', aibotid = botId} = {}) {
      const id = `fake-${Date.now()}-${++seq}`;
      state.socket?.send(JSON.stringify({cmd: 'aibot_msg_callback', headers: {req_id: id}, body: {
        msgid: id, aibotid, chattype, from: {userid}, msgtype: 'text', text: {content: text},
        ...(chattype === 'group' ? {chatid: 'group-1'} : {}),
      }}));
    },
    async close() {
      for (const c of server.clients) c.terminate();
      await new Promise(r => server.close(r));
    },
  };
}

/** 假扫码接口：每次 generate 开一轮，第 successAt 次 query_result 返回成功。 */
export async function startFakeQr({successAt = 3, botId = 'test-bot', secret = 'fake-secret-do-not-leak'} = {}) {
  const state = {generated: 0, polls: 0};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = body => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (url.pathname === '/ai/qc/generate') {
      state.generated++;
      state.polls = 0;
      return json({data: {scode: `scode-${state.generated}`, auth_url: `https://work.weixin.qq.com/ai/qc/preview?scode=scode-${state.generated}`}});
    }
    if (url.pathname === '/ai/qc/query_result') {
      state.polls++;
      return json({data: state.polls >= successAt ? {status: 'success', bot_info: {botid: botId, secret}} : {status: 'scaning'}});
    }
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    secret,
    async close() { server.closeAllConnections?.(); await new Promise(r => server.close(r)); },
  };
}
