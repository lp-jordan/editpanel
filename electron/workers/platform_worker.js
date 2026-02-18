const readline = require('readline');
const { misspellings, suggestions } = require('../spellcheck');
const { LeaderPassClient } = require('./leaderpass_client');

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const leaderPass = new LeaderPassClient({
  onEvent: event => writeResponse(event)
});

const handlers = {
  async ping() {
    return { status: 'ok' };
  },
  async leaderpass_auth(request) {
    const force = Boolean(request.force || request.force_refresh);
    const result = await leaderPass.authenticate(force);
    return { ok: true, ...result };
  },
  async leaderpass_upload(request) {
    const result = await leaderPass.uploadFile(request);
    return { ok: true, ...result };
  },
  async spellcheck_misspellings(request) {
    return misspellings(null, request.text || '');
  },
  async spellcheck_suggestions(request) {
    return suggestions(null, request.word || '');
  }
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  let reqId = null;
  const startedAt = Date.now();
  try {
    const request = JSON.parse(line);
    reqId = request.id;
    const cmd = request.cmd;
    const handler = handlers[cmd];
    if (!handler) {
      writeResponse({ id: reqId, ok: false, data: null, error: `unknown command: ${cmd}` });
      return;
    }
    const data = await handler(request);
    writeResponse({
      id: reqId,
      ok: true,
      data,
      error: null,
      trace_id: request.trace_id,
      metrics: {
        worker_latency_ms: Date.now() - startedAt,
        cmd
      }
    });
  } catch (error) {
    writeResponse({
      id: reqId,
      ok: false,
      data: null,
      error: error?.message || String(error),
      metrics: {
        worker_latency_ms: Date.now() - startedAt
      }
    });
  }
});
