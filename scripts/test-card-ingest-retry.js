'use strict';
// Card ingest: a failed read is retried from the same byte (reopening the file),
// and errors say which side failed. Offline: node scripts/test-card-ingest-retry.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashThrough } = require('../electron/workers/card_ingest_copy');

const data = crypto.randomBytes(20 * 1024 * 1024 + 123);     // 3 chunks
const want = crypto.createHash('sha1').update(data).digest('hex');

/** open() whose reads fail `fails` times in total, starting at the 2nd read. */
function flaky(fails) {
  let reads = 0, opens = 0, left = fails;
  const open = async () => {
    opens++;
    return {
      read: async (buf, off, len, pos) => {
        reads++;
        if (reads > 1 && left > 0) { left--; const e = new Error('UNKNOWN: unknown error, read'); e.code = 'UNKNOWN'; throw e; }
        const n = Math.max(0, Math.min(len, data.length - pos));
        data.copy(buf, off, pos, pos + n);
        return { bytesRead: n };
      },
      close: async () => {}
    };
  };
  return { open, stats: () => ({ reads, opens }) };
}

(async () => {
  const fast = { retryMs: [1, 1, 1] };
  // two failures: retried, same hash, written file identical
  const f = flaky(2);
  const tmp = path.join(os.tmpdir(), `ci-retry-${process.pid}`);
  const wfh = await fs.promises.open(tmp, 'w');
  const got = await hashThrough('card/A066C001.MXF', data.length, 0, 'copy', wfh, { ...fast, open: f.open });
  await wfh.close();
  assert.strictEqual(got, want);
  assert.ok(fs.readFileSync(tmp).equals(data), 'written copy matches');
  assert.strictEqual(f.stats().opens, 3, 'reopened per retry');
  fs.unlinkSync(tmp);

  // four failures in a row: gives up, says the card and where
  await assert.rejects(hashThrough('card/A066C001.MXF', data.length, 0, 'copy', null, { ...fast, open: flaky(4).open }),
    /^Error: Reading the card at 0\.0 of 0\.0 GB: UNKNOWN: unknown error, read \(tried 4 times\)$/);
  // verify side is named too
  await assert.rejects(hashThrough('nas/x', data.length, 0, 'verify', null, { ...fast, open: flaky(9).open }),
    /^Error: Checking: reading the NAS copy back/);
  // a write failure names the NAS
  const badW = { write: async () => { throw new Error('EIO: i/o error, write'); } };
  await assert.rejects(hashThrough('card/x', data.length, 0, 'copy', badW, { ...fast, open: flaky(0).open }),
    /^Error: Writing to the NAS at 0\.0 of 0\.0 GB: EIO/);
  // card gone at open
  await assert.rejects(hashThrough('card/x', 10, 0, 'copy', null, { open: async () => { throw new Error('ENOENT: no such file'); } }),
    /^Error: Reading the card at 0\.0 of 0\.0 GB: ENOENT/);
  console.log('✓ card ingest: failed reads retried from the same byte (same hash), errors name card / NAS check / NAS write');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
