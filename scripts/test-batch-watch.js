// The queue watch (1.2.158): every queued Message Batch is checked, whichever label is open;
// an ended one is announced once and timed in cut_through_batches.csv.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ct = require('../electron/workers/cut_through');

(async () => {
  const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-watch-'));
  let prefs = { cutThrough: { queuedBatches: {
    b1: { project: 'Proj', mc: 'MC 1', label: 'Day, A', videos: 4, submittedAt: Date.parse('2026-11-12T10:00:00Z'), model: 'claude-opus-5-5' },
    b2: { project: 'Proj', mc: 'MC 2', label: 'B', videos: 2, submittedAt: Date.now() },
    b3: { project: 'Proj', mc: 'MC 3', label: 'C', videos: 1, submittedAt: Date.now() }
  } } };
  const getPrefs = () => prefs;
  const setPrefs = (patch) => { prefs = { ...prefs, ...patch }; };
  const status = {
    b1: { processing_status: 'ended', created_at: '2026-11-12T10:00:30Z', ended_at: '2026-11-12T10:42:30Z',
      request_counts: { processing: 0, succeeded: 3, errored: 1, canceled: 0, expired: 0 } },
    b2: { processing_status: 'in_progress', created_at: '2026-11-12T10:00:00Z', ended_at: null, request_counts: { processing: 2 } }
  };
  let calls = 0;
  const api = { messages: { batches: { retrieve: async (id) => {
    calls += 1;
    if (!status[id]) { const e = new Error('not found'); e.status = 404; throw e; }
    return status[id];
  } } } };
  const ended = [];
  const c = ct.createCutThrough({ sendWorkerRequest: async () => ({ data: {} }), broadcast: () => {}, getPrefs, setPrefs,
    filesDir: FILES, claudeClient: api, onBatchEnded: (b) => ended.push(b) });

  await c.checkQueue();
  assert.strictEqual(calls, 3);
  assert.strictEqual(ended.length, 1, JSON.stringify(ended));
  assert.deepStrictEqual({ id: ended[0].id, label: ended[0].label, videos: ended[0].videos, minutes: ended[0].minutes, ok: ended[0].counts.succeeded },
    { id: 'b1', label: 'Day, A', videos: 4, minutes: 42, ok: 3 });
  assert.deepStrictEqual(Object.keys(prefs.cutThrough.queuedBatches), ['b2'], 'ended and gone batches leave the queue');
  assert.deepStrictEqual(prefs.cutThrough.endedBatches, ['b1']);
  const csv = fs.readFileSync(path.join(FILES, 'cut_through_batches.csv'), 'utf8').trim().split('\n');
  assert.strictEqual(csv[0], 'submitted_at,ended_at,minutes,project,multicam,label,videos,succeeded,errored,canceled,expired,model,batch_id');
  assert.strictEqual(csv[1], '2026-11-12T10:00:30.000Z,2026-11-12T10:42:30.000Z,42,Proj,MC 1,"Day, A",4,3,1,0,0,claude-opus-5-5,b1');

  // b2 ends later: announced once, never twice
  status.b2 = { processing_status: 'ended', created_at: '2026-11-12T10:00:00Z', ended_at: '2026-11-12T11:30:00Z',
    request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 2, expired: 0 } };
  await c.checkQueue();
  await c.checkQueue();
  assert.strictEqual(ended.length, 2);
  assert.strictEqual(ended[1].minutes, 90);
  assert.deepStrictEqual(prefs.cutThrough.queuedBatches, {});
  assert.strictEqual(fs.readFileSync(path.join(FILES, 'cut_through_batches.csv'), 'utf8').trim().split('\n').length, 3);

  // no listener: no watch at all (tests and older callers)
  prefs.cutThrough.queuedBatches = { b9: { label: 'X', videos: 1, submittedAt: Date.now() } };
  calls = 0;
  ct.createCutThrough({ sendWorkerRequest: async () => ({ data: {} }), broadcast: () => {}, getPrefs, setPrefs, filesDir: FILES, claudeClient: api });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls, 0);

  fs.rmSync(FILES, { recursive: true, force: true });
  console.log('batch watch: ok');
})().catch((err) => { console.error(err); process.exit(1); });
