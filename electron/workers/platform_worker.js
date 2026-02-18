const readline = require('readline');
const { misspellings, suggestions } = require('../spellcheck');

const handlers = {
  async ping() {
    return { status: 'ok' };
  },
  async leaderpass_auth() {
    return { ok: true, message: 'auth not configured' };
  },
  async leaderpass_upload() {
    return { ok: true, message: 'upload not configured' };
  },
  async spellcheck_misspellings(request) {
    return misspellings(null, request.text || '');
  },
  async spellcheck_suggestions(request) {
    return suggestions(null, request.word || '');
  }
};

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  let reqId = null;
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
    writeResponse({ id: reqId, ok: true, data, error: null });
  } catch (error) {
    writeResponse({ id: reqId, ok: false, data: null, error: error?.message || String(error) });
  }
});
