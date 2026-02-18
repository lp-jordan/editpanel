const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const readline = require('readline');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-worker-'));
  const filePath = path.join(tmpDir, 'sample.bin');
  fs.writeFileSync(filePath, Buffer.alloc(1024 * 32, 7));

  const sessions = new Map();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const json = (() => {
        try { return bodyText ? JSON.parse(bodyText) : {}; } catch (_err) { return {}; }
      })();

      if (req.url === '/oauth/token' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'token-123', expires_in: 120 }));
        return;
      }

      if (req.url === '/uploads/sessions' && req.method === 'POST') {
        const uploadId = `up-${Date.now()}`;
        sessions.set(uploadId, { chunks: 0, metadata: json.metadata || {} });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ upload_id: uploadId, chunk_size: json.chunk_size || 1024 }));
        return;
      }

      const chunkMatch = req.url.match(/^\/uploads\/([^/]+)\/chunks$/);
      if (chunkMatch && req.method === 'PUT') {
        const uploadId = decodeURIComponent(chunkMatch[1]);
        const session = sessions.get(uploadId);
        if (!session) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing session' }));
          return;
        }
        session.chunks += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, index: req.headers['x-chunk-index'] }));
        return;
      }

      const completeMatch = req.url.match(/^\/uploads\/([^/]+)\/complete$/);
      if (completeMatch && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ complete: true }));
        return;
      }

      const metadataMatch = req.url.match(/^\/uploads\/([^/]+)\/metadata$/);
      if (metadataMatch && ['POST', 'PATCH'].includes(req.method)) {
        const uploadId = decodeURIComponent(metadataMatch[1]);
        const session = sessions.get(uploadId);
        session.metadata = { ...(session.metadata || {}), ...(json.metadata || {}) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const verifyMatch = req.url.match(/^\/uploads\/([^/]+)\/verify$/);
      if (verifyMatch && req.method === 'GET') {
        const uploadId = decodeURIComponent(verifyMatch[1]);
        const session = sessions.get(uploadId);
        const complete = Boolean(session && session.metadata && session.metadata.title);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ complete, missing_fields: complete ? [] : ['title'] }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const worker = spawn(process.execPath, [path.join(__dirname, '..', 'electron', 'workers', 'platform_worker.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      LEADERPASS_BASE_URL: `http://127.0.0.1:${port}`,
      LEADERPASS_CLIENT_ID: 'client',
      LEADERPASS_CLIENT_SECRET: 'secret',
      LEADERPASS_SESSION_SECRET: 'signing-secret',
      LEADERPASS_CHECKPOINT_PATH: path.join(tmpDir, 'checkpoints.json')
    }
  });

  const reader = readline.createInterface({ input: worker.stdout });
  const responses = new Map();
  const events = [];

  reader.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id) {
      responses.set(msg.id, msg);
    } else if (msg.event) {
      events.push(msg);
    }
  });

  function send(cmd, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = `${cmd}-${Date.now()}-${Math.random()}`;
      worker.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
      const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${cmd}`)), 5000);
      const poll = setInterval(() => {
        if (responses.has(id)) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve(responses.get(id));
          responses.delete(id);
        }
      }, 10);
    });
  }

  const auth = await send('leaderpass_auth', { force: true });
  assert.strictEqual(auth.ok, true, 'auth should succeed');

  const upload = await send('leaderpass_upload', {
    file_path: filePath,
    chunk_size: 4096,
    metadata: { title: 'Test Upload', source: 'unit-test' }
  });

  assert.strictEqual(upload.ok, true, 'upload should succeed');
  assert.strictEqual(upload.data.complete, true, 'upload should complete');
  assert.ok(upload.data.upload_id, 'upload id should be returned');
  assert.ok(events.some(e => e.code === 'LEADERPASS_UPLOAD_PROGRESS'), 'progress events should be emitted');
  assert.ok(events.some(e => e.code === 'LEADERPASS_API_LATENCY'), 'latency events should be emitted');

  worker.kill('SIGTERM');
  server.close();
  console.log('platform worker leaderpass checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
