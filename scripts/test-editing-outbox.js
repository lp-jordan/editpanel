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

  // Outbox is capped.
  for (let i = 0; i < 5010; i++) db.emitEvent('x.y', { title: `t${i}` });
  assert.equal(db.takeOutbox(10000).length, 5000);
  db.emitEvent('', { title: 'no kind' }); // ignored, doesn't throw
  console.log('editing outbox: ok');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
