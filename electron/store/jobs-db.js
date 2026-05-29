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
    `);

    // 2026-05-27 — capture the Resolve project + timeline at enqueue time so
    // we can refuse to apply a saved resolution against a different project.
    // ALTER TABLE ADD COLUMN is idempotent-guarded via PRAGMA table_info.
    const cols = new Set(
      this.db.prepare(`PRAGMA table_info(result_runs)`).all().map(r => r.name)
    );
    if (!cols.has('project_name')) {
      this.db.exec(`ALTER TABLE result_runs ADD COLUMN project_name TEXT`);
    }
    if (!cols.has('timeline_name')) {
      this.db.exec(`ALTER TABLE result_runs ADD COLUMN timeline_name TEXT`);
    }

    this.db.exec(`

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

      CREATE TABLE IF NOT EXISTS atem_ingest_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session     TEXT    NOT NULL,
        ftp_host    TEXT    NOT NULL,
        dest        TEXT    NOT NULL,
        file_count  INTEGER NOT NULL DEFAULT 0,
        files_done  INTEGER NOT NULL DEFAULT 0,
        state       TEXT    NOT NULL DEFAULT 'running',
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        error       TEXT
      );

      CREATE TABLE IF NOT EXISTS atem_ingest_files (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id      INTEGER NOT NULL,
        session     TEXT    NOT NULL,
        filename    TEXT    NOT NULL,
        dest_path   TEXT    NOT NULL DEFAULT '',
        cam_number  INTEGER,
        take_number INTEGER,
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        state       TEXT    NOT NULL DEFAULT 'pending',
        error       TEXT,
        UNIQUE(log_id, filename)
      );

      CREATE INDEX IF NOT EXISTS idx_atem_log_session ON atem_ingest_log(session);

      CREATE TABLE IF NOT EXISTS export_runs (
        export_id    TEXT    PRIMARY KEY,
        target_dir   TEXT,
        project_id   TEXT,
        project_name TEXT,
        job_count    INTEGER NOT NULL DEFAULT 0,
        jobs_done    INTEGER NOT NULL DEFAULT 0,
        percent      INTEGER NOT NULL DEFAULT 0,
        state        TEXT    NOT NULL DEFAULT 'rendering',
        jobs_json    TEXT,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        error        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_export_runs_started ON export_runs(started_at);
    `);
  }

  /**
   * Initialise a result run and bulk-insert pending items.
   * Items that already exist (same job_id + item_key) are left untouched,
   * so re-running after a partial completion resumes cleanly.
   */
  initRun(jobId, itemType, label, items, scope = {}) {
    const upsertRun = this.db.prepare(
      `INSERT OR IGNORE INTO result_runs (job_id, item_type, label, created_at, project_name, timeline_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    upsertRun.run(
      jobId,
      itemType,
      label || itemType,
      Date.now(),
      scope.projectName || null,
      scope.timelineName || null
    );

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
        r.project_name,
        r.timeline_name,
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

  /**
   * Delete a single run and all of its items. Used by the per-row "×" in the
   * Jobs panel so users can clear stuck or stale entries.
   */
  deleteRun(jobId) {
    this.db.prepare(`DELETE FROM result_items WHERE job_id = ?`).run(jobId);
    this.db.prepare(`DELETE FROM result_runs  WHERE job_id = ?`).run(jobId);
    return { ok: true };
  }

  /**
   * Delete all runs older than `olderThanMs`. Drives the "Clear older than N days"
   * sweep so the SQLite file doesn't grow unbounded over a user's lifetime.
   * Returns the count of deleted runs.
   */
  pruneRuns(olderThanMs) {
    const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
    const targets = this.db
      .prepare(`SELECT job_id FROM result_runs WHERE created_at < ?`)
      .all(cutoff);
    if (targets.length === 0) return { ok: true, data: { deleted: 0 } };
    const deleteItems = this.db.prepare(`DELETE FROM result_items WHERE job_id = ?`);
    const deleteRun   = this.db.prepare(`DELETE FROM result_runs  WHERE job_id = ?`);
    for (const row of targets) {
      deleteItems.run(row.job_id);
      deleteRun.run(row.job_id);
    }
    return { ok: true, data: { deleted: targets.length } };
  }

  // ─── ATEM ingest log ──────────────────────────────────────

  /** Create a log entry for a new ingest run. Returns the new row id. */
  createAtemLog(session, ftpHost, dest, fileCount) {
    const stmt = this.db.prepare(
      `INSERT INTO atem_ingest_log (session, ftp_host, dest, file_count, state, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`
    );
    const result = stmt.run(session, ftpHost, dest, fileCount, Date.now());
    return result.lastInsertRowid;
  }

  /** Update a log entry (partial update — only provided keys are written). */
  updateAtemLog(id, { state, filesDone, error, finishedAt } = {}) {
    const fields = [];
    const values = [];
    if (state      !== undefined) { fields.push('state = ?');       values.push(state); }
    if (filesDone  !== undefined) { fields.push('files_done = ?');  values.push(filesDone); }
    if (error      !== undefined) { fields.push('error = ?');       values.push(error); }
    if (finishedAt !== undefined) { fields.push('finished_at = ?'); values.push(finishedAt); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE atem_ingest_log SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Mark an individual file as done. */
  markAtemFileDone(logId, filename, destPath, camNumber, takeNumber, sizeBytes) {
    this.db.prepare(
      `INSERT INTO atem_ingest_files (log_id, session, filename, dest_path, cam_number, take_number, size_bytes, state)
       SELECT ?, session, ?, ?, ?, ?, ?, 'done' FROM atem_ingest_log WHERE id = ?
       ON CONFLICT(log_id, filename) DO UPDATE SET state='done', dest_path=excluded.dest_path`
    ).run(logId, filename, destPath, camNumber ?? null, takeNumber ?? null, sizeBytes ?? 0, logId);
  }

  /** Mark an individual file as failed. */
  markAtemFileFailed(logId, filename, error) {
    this.db.prepare(
      `INSERT INTO atem_ingest_files (log_id, session, filename, dest_path, state, error)
       SELECT ?, session, ?, '', 'failed', ? FROM atem_ingest_log WHERE id = ?
       ON CONFLICT(log_id, filename) DO UPDATE SET state='failed', error=excluded.error`
    ).run(logId, filename, error, logId);
  }

  /**
   * Return recent ingest logs, newest first.
   * Optionally filter by session name to check prior ingest status.
   */
  listAtemLogs(limit = 30, session = null) {
    if (session) {
      return this.db.prepare(
        `SELECT * FROM atem_ingest_log WHERE session = ? ORDER BY started_at DESC LIMIT ?`
      ).all(session, limit);
    }
    return this.db.prepare(
      `SELECT * FROM atem_ingest_log ORDER BY started_at DESC LIMIT ?`
    ).all(limit);
  }

  /** Mark any stale 'running' logs (e.g. from a crashed session) as interrupted. */
  clearStaleAtemLogs() {
    this.db.prepare(
      `UPDATE atem_ingest_log SET state = 'interrupted', finished_at = ?
       WHERE state = 'running'`
    ).run(Date.now());
  }

  // ─── Export / render runs ─────────────────────────────────

  /** Record a new export run (one render queue dispatched by EditPanel). */
  createExportRun({ exportId, targetDir, projectId, projectName, jobs }) {
    const list = Array.isArray(jobs) ? jobs : [];
    this.db.prepare(
      `INSERT OR REPLACE INTO export_runs
         (export_id, target_dir, project_id, project_name, job_count, jobs_done, percent, state, jobs_json, started_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'rendering', ?, ?)`
    ).run(
      exportId,
      targetDir || null,
      projectId || null,
      projectName || null,
      list.length,
      JSON.stringify(list),
      Date.now()
    );
    return exportId;
  }

  /** Partial update of an export run (only provided keys are written). */
  updateExportRun(exportId, { state, jobsDone, percent, jobs, error, finishedAt } = {}) {
    const fields = [];
    const values = [];
    if (state      !== undefined) { fields.push('state = ?');       values.push(state); }
    if (jobsDone   !== undefined) { fields.push('jobs_done = ?');   values.push(jobsDone); }
    if (percent    !== undefined) { fields.push('percent = ?');     values.push(percent); }
    if (jobs       !== undefined) { fields.push('jobs_json = ?');   values.push(JSON.stringify(jobs)); }
    if (error      !== undefined) { fields.push('error = ?');       values.push(error); }
    if (finishedAt !== undefined) { fields.push('finished_at = ?'); values.push(finishedAt); }
    if (fields.length === 0) return;
    values.push(exportId);
    this.db.prepare(`UPDATE export_runs SET ${fields.join(', ')} WHERE export_id = ?`).run(...values);
  }

  /** Recent export runs, newest first, with jobs parsed back into an array. */
  listExportRuns(limit = 10) {
    return this.db
      .prepare(`SELECT * FROM export_runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit)
      .map(row => ({
        ...row,
        jobs: row.jobs_json ? JSON.parse(row.jobs_json) : []
      }));
  }

  /** Mark any non-terminal export from a prior session as interrupted — the
   *  in-memory tracker (and any startable pending queue) is lost on restart. */
  clearStaleExportRuns() {
    this.db.prepare(
      `UPDATE export_runs SET state = 'interrupted', finished_at = ?
       WHERE state IN ('rendering', 'uploading', 'queued')`
    ).run(Date.now());
  }

  close() {
    try { this.db.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { JobsDb };
