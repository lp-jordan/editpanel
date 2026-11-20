'use strict';
// Editing dashboard outbox (LPOS /editing): export state changes queue the
// right events, and the outbox drains. Run: npm run test:editing-outbox
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobsDb } = require('../electron/store/jobs-db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-outbox-'));
const db = new JobsDb(path.join(dir, 'jobs.db'));
const kinds = () => db.takeOutbox(1000).map((e) => e.kind);
const titles = () => db.takeOutbox(1000).map((e) => e.title);
const drain = () => db.dropOutbox(db.takeOutbox(1000).map((e) => e.id));

try {
  // Started → uploading → delivered, with an asset link.
  const job = { job_id: '1', name: 'J104', outputPath: 'C:\\out\\J104_v3.mov' };
  db.createExportRun({ exportId: 'e1', projectId: 'p1', projectName: 'Northwind S2', jobs: [job] });
  db.updateExportRun('e1', { state: 'rendering', percent: 50 }); // no change → nothing
  db.updateExportRun('e1', { state: 'uploading' });
  db.setExportLposDelivery('e1', { project_id: 'p1', project_name: 'Northwind S2', file_ids: ['a9'] });
  db.setExportState('e1', 'delivered');
  const ev = db.takeOutbox(10);
  assert.deepEqual(ev.map((e) => e.kind), ['render.started', 'upload.delivered']);
  assert.equal(ev[1].title, 'Delivered J104_v3.mov to Northwind S2');
  assert.equal(ev[1].project_id, 'p1');
  assert.equal(ev[1].asset_id, 'a9');
  assert.match(ev[0].id, /^[A-Za-z0-9_-]{8,80}$/);
  drain();

  // Queued rows don't say "Rendering" until they start.
  db.createExportRun({ exportId: 'e2', jobs: [job, job], state: 'queued' });
  assert.deepEqual(kinds(), []);
  db.updateExportRun('e2', { state: 'rendering' });
  db.updateExportRun('e2', { state: 'failed', error: 'Disk full' });
  assert.deepEqual(titles(), ['Rendering J104_v3.mov +1 more', 'Render failed: J104_v3.mov +1 more (Disk full)']);
  drain();

  // Upload failure, split rows, orphans, cancel.
  db.createExportRun({ exportId: 'e3', jobs: [job] });
  db.updateExportRun('e3', { state: 'uploading' });
  db.updateExportRun('e3', { state: 'failed', error: 'LPOS unreachable' });
  db.createExportRun({ exportId: 'e4', jobs: [job], emit: false });
  db.updateExportRun('e4', { state: 'complete_unassigned' });
  db.createOrphanExportRun({ exportId: 'orphan_7', jobs: [{ JobId: '7', OutputFilename: 'Promo.mp4' }] });
  db.createOrphanExportRun({ exportId: 'orphan_7', jobs: [] }); // re-insert ignored → nothing
  db.updateExportRun('orphan_7', { state: 'canceled' });
  assert.deepEqual(kinds(), ['render.started', 'upload.failed', 'render.unassigned', 'render.started', 'render.cancelled']);
  assert.equal(titles()[3], 'Rendering Promo.mp4');
  drain();
  assert.equal(db.takeOutbox().length, 0);

  // ATEM pull: counts done files, cams and size once it leaves 'running'.
  const atem = db.createAtemLog('Session 3', '10.0.0.5', 'N:/x', 3);
  db.markAtemFileDone(atem, 'CAM1.mov', 'N:/x/CAM1.mov', 1, 1, 30e9);
  db.markAtemFileDone(atem, 'CAM2.mov', 'N:/x/CAM2.mov', 2, 1, 31.2e9);
  db.markAtemFileFailed(atem, 'CAM3.mov', 'timeout');
  db.updateAtemLog(atem, { filesDone: 2 });
  assert.deepEqual(kinds(), []);
  db.updateAtemLog(atem, { state: 'completed', finishedAt: Date.now() });
  db.updateAtemLog(atem, { state: 'completed' }); // already finished → nothing
  let e = db.takeOutbox(10);
  assert.deepEqual(e.map((x) => x.kind), ['ingest.atem.finished']);
  assert.equal(e[0].title, 'ATEM pull Session 3: 2 files, 2 cams, 61.2 GB, 1 failed');
  assert.equal(e[0].phase, 'failed');
  drain();

  // Card ingest.
  db.createCardIngestRun('ci-1', Date.now());
  db.finishCardIngestRun('ci-1', 'done', { cards: [
    { label: 'E:', report: { copied: 40, copiedBytes: 100e9, failed: 0, onNas: 0, safeToFormat: true } },
    { label: 'F:', report: { copied: 44, copiedBytes: 112.4e9, failed: 0, onNas: 2, safeToFormat: true } },
  ] });
  e = db.takeOutbox(10);
  assert.equal(e[0].kind, 'ingest.card.finished');
  assert.equal(e[0].title, 'Card ingest E:, F: · 84 files, 212.4 GB, 2 already on the NAS, safe to format');
  assert.equal(e[0].phase, undefined);
  drain();

  // Outbox is capped.
  for (let i = 0; i < 5010; i++) db.emitEvent('x.y', { title: `t${i}` });
  assert.equal(db.takeOutbox(10000).length, 5000);
  db.emitEvent('', { title: 'no kind' }); // ignored, doesn't throw
  console.log('editing outbox: ok');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
