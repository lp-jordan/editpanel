'use strict';

/**
 * JobsDb — SQLite store for result runs and per-item review state.
 *
 * Uses node:sqlite's DatabaseSync (available in Node 22+, included in Electron 42).
 * No native compilation — same pattern as lpos-dashboard.
 *
 * Tables:
 *   result_runs   — one row per named result set (e.g. a spellcheck run)
 *   result_items  — one row per reviewable item (e.g. one misspelled word)
 */

const { DatabaseSync } = require('node:sqlite');

class JobsDb {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS result_runs (
        job_id     TEXT PRIMARY KEY,
        item_type  TEXT NOT NULL,
        label      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS result_items (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id           TEXT NOT NULL,
        item_key         TEXT NOT NULL,
        item_type        TEXT NOT NULL,
        item_data_json   TEXT,
        state            TEXT NOT NULL DEFAULT 'pending',
        resolution_json  TEXT,
        resolved_at      INTEGER,
        UNIQUE(job_id, item_key)
      );

      CREATE INDEX IF NOT EXISTS idx_result_items_job_id ON result_items(job_id);
    `);
  }

  /**
   * Initialise a result run and bulk-insert pending items.
   * Items that already exist (same job_id + item_key) are left untouched,
   * so re-running after a partial completion resumes cleanly.
   */
  initRun(jobId, itemType, label, items) {
    const upsertRun = this.db.prepare(
      `INSERT OR IGNORE INTO result_runs (job_id, item_type, label, created_at)
       VALUES (?, ?, ?, ?)`
    );
    upsertRun.run(jobId, itemType, label || itemType, Date.now());

    const insertItem = this.db.prepare(
      `INSERT OR IGNORE INTO result_items (job_id, item_key, item_type, item_data_json, state)
       VALUES (?, ?, ?, ?, 'pending')`
    );
    for (const item of items) {
      insertItem.run(jobId, item.key, itemType, JSON.stringify(item.data ?? null));
    }
    return { ok: true };
  }

  /**
   * List recent runs with item counts, sorted newest-first.
   */
  listRuns(limit = 20) {
    const stmt = this.db.prepare(`
      SELECT
        r.job_id,
        r.item_type,
        r.label,
        r.created_at,
        COUNT(i.id)                                      AS total,
        SUM(CASE WHEN i.state = 'resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN i.state = 'skipped'  THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN i.state = 'pending'  THEN 1 ELSE 0 END) AS pending
      FROM result_runs r
      LEFT JOIN result_items i ON i.job_id = r.job_id
      GROUP BY r.job_id
      ORDER BY r.created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  /**
   * Get all items for a run, in insertion order.
   */
  getItems(jobId) {
    const stmt = this.db.prepare(
      `SELECT id, job_id, item_key, item_type, item_data_json, state, resolution_json, resolved_at
       FROM result_items
       WHERE job_id = ?
       ORDER BY id`
    );
    return stmt.all(jobId).map(row => ({
      id: row.id,
      job_id: row.job_id,
      item_key: row.item_key,
      item_type: row.item_type,
      state: row.state,
      resolved_at: row.resolved_at,
      item_data: row.item_data_json ? JSON.parse(row.item_data_json) : null,
      resolution: row.resolution_json ? JSON.parse(row.resolution_json) : null
    }));
  }

  /**
   * Mark an item as resolved with an arbitrary resolution payload.
   */
  resolveItem(jobId, itemKey, resolution) {
    const stmt = this.db.prepare(
      `UPDATE result_items
       SET state = 'resolved', resolution_json = ?, resolved_at = ?
       WHERE job_id = ? AND item_key = ?`
    );
    stmt.run(JSON.stringify(resolution ?? null), Date.now(), jobId, itemKey);
    return { ok: true };
  }

  /**
   * Mark an item as skipped.
   */
  skipItem(jobId, itemKey) {
    const stmt = this.db.prepare(
      `UPDATE result_items
       SET state = 'skipped', resolved_at = ?
       WHERE job_id = ? AND item_key = ?`
    );
    stmt.run(Date.now(), jobId, itemKey);
    return { ok: true };
  }

  /**
   * Reset all items in a run back to pending (for a full re-review).
   */
  resetRun(jobId) {
    const stmt = this.db.prepare(
      `UPDATE result_items
       SET state = 'pending', resolution_json = NULL, resolved_at = NULL
       WHERE job_id = ?`
    );
    stmt.run(jobId);
    return { ok: true };
  }

  close() {
    try { this.db.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { JobsDb };
