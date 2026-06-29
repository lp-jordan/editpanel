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

    // 2026-06-03 — Phase 3.5 orphan-export reconciliation.
    //   source              — 'editpanel' (queued via overlay) | 'reconciled'
    //                         (caught from Resolve's queue) | 'filesystem' (future)
    //   output_paths_json   — concrete on-disk file paths captured at render
    //                         completion. Drives the Exports UI "Local" link.
    //   lpos_delivery_json  — { project_id, project_name, file_ids, uploaded_at }
    //                         once upload finishes. Powers the LPOS deep-link.
    // Idempotent ALTER guard via PRAGMA table_info, same pattern as result_runs.
    const exportCols = new Set(
      this.db.prepare(`PRAGMA table_info(export_runs)`).all().map(r => r.name)
    );
    if (!exportCols.has('source')) {
      this.db.exec(`ALTER TABLE export_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'editpanel'`);
    }
    if (!exportCols.has('output_paths_json')) {
      this.db.exec(`ALTER TABLE export_runs ADD COLUMN output_paths_json TEXT`);
    }
    if (!exportCols.has('lpos_delivery_json')) {
      this.db.exec(`ALTER TABLE export_runs ADD COLUMN lpos_delivery_json TEXT`);
    }

    // 2026-06-03 — "Dismiss from job queue" model. JobPanel is the transient
    // monitor; ExportsPanel on /deliver is the concrete record. Clicking the X
    // on JobPanel sets this flag to 1 so the row disappears from JobPanel
    // (export:recent filters on it) but stays visible in ExportsPanel (which
    // queries everything regardless). 0 = visible in JobPanel; 1 = hidden.
    if (!exportCols.has('hidden_from_jobpanel')) {
      this.db.exec(`ALTER TABLE export_runs ADD COLUMN hidden_from_jobpanel INTEGER NOT NULL DEFAULT 0`);
    }

    // One-shot migration of any rows that landed in the short-lived
    // 'user_dismissed' state from 1.1.6. Convert them to "complete_unassigned
    // + hidden_from_jobpanel" — closest match for the intent (orphan, hidden
    // from JobPanel, still listed in ExportsPanel). Safe to run repeatedly:
    // hits zero rows after the first run.
    try {
      this.db.exec(
        `UPDATE export_runs
         SET state = 'complete_unassigned', hidden_from_jobpanel = 1
         WHERE state = 'user_dismissed'`
      );
    } catch (_) { /* non-fatal */ }

    // 2026-06-29 — retire the `dismissed_in_resolve` state. When an editor
    // pulls a render from Resolve's queue before it finishes, EditPanel now
    // simply forgets it (the reconciler hard-DELETEs the orphan row) instead
    // of keeping a tombstone. Clear out any tombstones left by older builds so
    // they stop showing in ExportsPanel. Safe to run repeatedly — zero rows
    // after the first pass.
    try {
      this.db.exec(`DELETE FROM export_runs WHERE state = 'dismissed_in_resolve'`);
    } catch (_) { /* non-fatal */ }
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
   * Flip a single item back to pending so the reviewer can change their
   * earlier Skip / Apply decision. The previous resolution_json is cleared.
   * Note: for applied items, this does NOT undo the Resolve text write —
   * the caller is responsible for surfacing that nuance in the UI.
   */
  reopenItem(jobId, itemKey) {
    const stmt = this.db.prepare(
      `UPDATE result_items
       SET state = 'pending', resolution_json = NULL, resolved_at = NULL
       WHERE job_id = ? AND item_key = ?`
    );
    stmt.run(jobId, itemKey);
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

  /**
   * Recent export runs, newest first, with JSON columns parsed back to arrays/objects.
   *
   * Backward-compatible signature — pass a number for the old behavior:
   *   listExportRuns(10)
   *
   * Or pass an options object for filtered queries (Phase 3.5 Exports UI):
   *   listExportRuns({ limit: 200, state: 'complete_unassigned' })
   *   listExportRuns({ state: ['delivered','complete_unassigned'] })
   *   listExportRuns({ source: 'reconciled', projectId: null })
   *   listExportRuns({ unassignedOnly: true })  // shorthand
   *   listExportRuns({ excludeState: 'user_dismissed' })  // soft-deletes hidden
   */
  listExportRuns(options = {}) {
    const opts = typeof options === 'number' ? { limit: options } : (options || {});
    const limit = Number.isFinite(opts.limit) ? opts.limit : 200;

    const where = [];
    const params = [];

    if (opts.unassignedOnly) {
      where.push(`state = 'complete_unassigned'`);
    }
    if (opts.state !== undefined && opts.state !== null) {
      if (Array.isArray(opts.state)) {
        if (opts.state.length > 0) {
          where.push(`state IN (${opts.state.map(() => '?').join(',')})`);
          params.push(...opts.state);
        }
      } else {
        where.push(`state = ?`);
        params.push(opts.state);
      }
    }
    // Allow callers to exclude one or more states (e.g. 'user_dismissed' so the
    // Exports UI doesn't surface soft-deleted orphans). Not unconditional —
    // the reconciler still needs to see user_dismissed rows so their JobIds
    // stay in trackedJobIds and don't trigger re-discovery.
    if (opts.excludeState !== undefined && opts.excludeState !== null) {
      if (Array.isArray(opts.excludeState)) {
        if (opts.excludeState.length > 0) {
          where.push(`state NOT IN (${opts.excludeState.map(() => '?').join(',')})`);
          params.push(...opts.excludeState);
        }
      } else {
        where.push(`state != ?`);
        params.push(opts.excludeState);
      }
    }
    if (opts.source) {
      where.push(`source = ?`);
      params.push(opts.source);
    }
    // hiddenFromJobpanel: true → only hidden rows; false → only visible rows;
    // undefined → all rows. JobPanel passes false; ExportsPanel omits the
    // option so both hidden and visible rows surface.
    if (opts.hiddenFromJobpanel === true) {
      where.push(`hidden_from_jobpanel = 1`);
    } else if (opts.hiddenFromJobpanel === false) {
      where.push(`hidden_from_jobpanel = 0`);
    }
    if (opts.projectId !== undefined) {
      if (opts.projectId === null) {
        where.push(`project_id IS NULL`);
      } else {
        where.push(`project_id = ?`);
        params.push(opts.projectId);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM export_runs ${whereSql} ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);

    return this.db
      .prepare(sql)
      .all(...params)
      .map(row => ({
        ...row,
        jobs: row.jobs_json ? JSON.parse(row.jobs_json) : [],
        output_paths: row.output_paths_json ? JSON.parse(row.output_paths_json) : [],
        lpos_delivery: row.lpos_delivery_json ? JSON.parse(row.lpos_delivery_json) : null
      }));
  }

  /** Fetch a single export row by id, with the same JSON parsing as listExportRuns. */
  getExportRun(exportId) {
    const row = this.db
      .prepare(`SELECT * FROM export_runs WHERE export_id = ?`)
      .get(exportId);
    if (!row) return null;
    return {
      ...row,
      jobs: row.jobs_json ? JSON.parse(row.jobs_json) : [],
      output_paths: row.output_paths_json ? JSON.parse(row.output_paths_json) : [],
      lpos_delivery: row.lpos_delivery_json ? JSON.parse(row.lpos_delivery_json) : null
    };
  }

  /** Delete a single export run from the recent list. */
  deleteExportRun(exportId) {
    this.db.prepare(`DELETE FROM export_runs WHERE export_id = ?`).run(exportId);
  }

  /** Mark any non-terminal export from a prior session as interrupted — the
   *  in-memory tracker (and any startable pending queue) is lost on restart.
   *  `complete_unassigned` is intentionally excluded: orphans waiting for the
   *  user to pick a project should persist verbatim across restarts. */
  clearStaleExportRuns() {
    this.db.prepare(
      `UPDATE export_runs SET state = 'interrupted', finished_at = ?
       WHERE state IN ('rendering', 'uploading', 'queued')`
    ).run(Date.now());
  }

  // ─── Phase 3.5 — orphan export reconciliation ────────────────

  /**
   * Insert (or replace) an orphan export discovered by reconciling Resolve's
   * render queue against export_runs. project_id is intentionally NULL —
   * orphans require explicit user assignment via the Exports UI before they
   * upload to LPOS. source='reconciled' distinguishes "we caught this" from
   * "the editor queued it" so the UI can render the right badge / badge text.
   */
  createOrphanExportRun({ exportId, targetDir, projectName, jobs, state = 'rendering', startedAt } = {}) {
    if (!exportId) throw new Error('createOrphanExportRun: exportId is required');
    const list = Array.isArray(jobs) ? jobs : [];
    // INSERT OR IGNORE is intentional: the reconciler keys orphan rows by
    // Resolve JobId (export_id = 'orphan_' + jobId). If a tick race ever
    // re-fires this insert for an already-tracked job, we must NOT reset
    // the row's state — an orphan in 'complete_unassigned' getting flipped
    // back to 'rendering' would lose the user's pending-action signal.
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO export_runs
         (export_id, target_dir, project_id, project_name, job_count, jobs_done,
          percent, state, jobs_json, started_at, source)
       VALUES (?, ?, NULL, ?, ?, 0, 0, ?, ?, ?, 'reconciled')`
    ).run(
      exportId,
      targetDir || null,
      projectName || null,
      list.length,
      state,
      JSON.stringify(list),
      Number.isFinite(startedAt) ? startedAt : Date.now()
    );
    return { exportId, inserted: info.changes > 0 };
  }

  /**
   * Record the concrete on-disk file paths Resolve produced for this export.
   * Captured at render-completion time. Drives the Exports UI "Local" link
   * and the "Open folder" action.
   */
  setExportOutputPaths(exportId, outputPaths) {
    const paths = Array.isArray(outputPaths) ? outputPaths : [];
    this.db.prepare(
      `UPDATE export_runs SET output_paths_json = ? WHERE export_id = ?`
    ).run(JSON.stringify(paths), exportId);
  }

  /**
   * Record where this export landed in LPOS once the upload finishes.
   * delivery shape: { project_id, project_name, file_ids: [...], uploaded_at }
   * Powers the Exports UI's deep-link to the LPOS project row.
   */
  setExportLposDelivery(exportId, delivery) {
    this.db.prepare(
      `UPDATE export_runs SET lpos_delivery_json = ? WHERE export_id = ?`
    ).run(delivery ? JSON.stringify(delivery) : null, exportId);
  }

  /**
   * Assign an LPOS project to an orphan export. Does NOT trigger the upload —
   * the caller (IPC handler) kicks the existing upload flow afterward, then
   * the upload-finish hook calls setExportLposDelivery + setExportState('delivered').
   */
  assignExportProject(exportId, projectId, projectName) {
    this.db.prepare(
      `UPDATE export_runs SET project_id = ?, project_name = ? WHERE export_id = ?`
    ).run(projectId || null, projectName || null, exportId);
  }

  /** Generic state setter — wrapper around updateExportRun for clarity at call sites. */
  setExportState(exportId, state, extra = {}) {
    this.updateExportRun(exportId, { state, ...extra });
  }

  /** Hide / un-hide an export row from JobPanel without affecting its state
   *  or its visibility in ExportsPanel. Used by the JobPanel X button and the
   *  Clear-all action. */
  setExportHiddenFromJobpanel(exportId, hidden) {
    this.db.prepare(
      `UPDATE export_runs SET hidden_from_jobpanel = ? WHERE export_id = ?`
    ).run(hidden ? 1 : 0, exportId);
  }

  /**
   * Count exports in the `complete_unassigned` state, EXCLUDING rows the
   * editor has dismissed from JobPanel. Drives the Jobs-tab clearable pill
   * ("N exports awaiting assignment → Review"); when the editor dismisses
   * an orphan from JobPanel the row stays in DB (so ExportsPanel keeps the
   * concrete record) but the pill should also stop nagging — that's why
   * hidden_from_jobpanel is part of the count filter.
   *
   * Restricted to terminal-but-unassigned so still-rendering orphans don't
   * inflate the count.
   */
  countUnassignedExports() {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM export_runs
       WHERE state = 'complete_unassigned' AND hidden_from_jobpanel = 0`
    ).get();
    return row?.n || 0;
  }

  close() {
    try { this.db.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { JobsDb };
