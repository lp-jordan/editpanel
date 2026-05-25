'use strict';

/**
 * atem_ftp.js — FTP access layer for ATEM ISO Extreme SDI.
 *
 * Used directly in main.js (not a worker subprocess).
 *
 * ATEM FTP folder structure:
 *   /
 *   └── <drive-name>/                     ← one drive, name irrelevant
 *       └── <SessionName>/                ← e.g. "ProjectName 2026-05-22"
 *           ├── <Session>.drp             ← ignored
 *           ├── *_Program_*.mp4           ← ignored
 *           ├── Audio Source Files/       ← ignored
 *           └── Video ISO Files/
 *               ├── SessionName_CAM 1 1.mov   ← CAM {n} {take}
 *               ├── SessionName_CAM 1 2.mov
 *               ├── SessionName_CAM 2 1.mov
 *               └── ...
 */

const { Client } = require('basic-ftp');
const fs = require('fs');
const path = require('path');

const VIDEO_ISO_FOLDER = 'Video ISO Files';
const DEFAULT_PORT = 21;

/**
 * Parse camera number and take number from an ATEM video filename.
 * Pattern: anything + "_CAM {camNum} {takeNum}.ext"
 * e.g. "Session_CAM 1 2.mov" → { camNumber: 1, takeNumber: 2 }
 */
function parseCameraInfo(filename) {
  const match = filename.match(/_CAM (\d+) (\d+)\./i);
  if (!match) return null;
  return {
    camNumber: parseInt(match[1], 10),
    takeNumber: parseInt(match[2], 10)
  };
}

function camFolderName(camNumber) {
  return `CAM ${camNumber}`;
}

function makeClient() {
  const client = new Client();
  client.ftp.verbose = false;
  return client;
}

/**
 * Connect to the ATEM FTP and list all recording sessions.
 * Returns { ok, data: Session[] } or { ok: false, error }.
 *
 * Session: {
 *   name: string,
 *   ftpSessionPath: string,
 *   ftpVideoPath: string,
 *   fileCount: number,
 *   totalBytes: number,
 *   files: Array<{ name: string, size: number }>
 * }
 */
async function listSessions(host, port = DEFAULT_PORT) {
  const client = makeClient();
  try {
    await client.access({ host, port });

    // Root contains drive folder(s) — name is irrelevant, use first one found.
    const rootItems = await client.list('/');
    const drives = rootItems.filter(i => i.isDirectory);
    if (drives.length === 0) {
      return { ok: false, error: 'No drive folder found on ATEM FTP root.' };
    }

    const drivePath = `/${drives[0].name}`;
    const sessionItems = await client.list(drivePath);
    const sessionDirs = sessionItems.filter(i => i.isDirectory);

    const sessions = [];
    for (const dir of sessionDirs) {
      const sessionPath = `${drivePath}/${dir.name}`;
      const videoPath   = `${sessionPath}/${VIDEO_ISO_FOLDER}`;

      let files = [];
      let totalBytes = 0;
      try {
        const videoItems = await client.list(videoPath);
        files = videoItems
          .filter(i => i.isFile && /\.mov$/i.test(i.name))
          .map(i => ({ name: i.name, size: i.size || 0 }));
        totalBytes = files.reduce((s, f) => s + f.size, 0);
      } catch (_err) {
        // No Video ISO Files folder — skip this session.
        continue;
      }

      if (files.length === 0) continue;

      sessions.push({
        name:           dir.name,
        ftpSessionPath: sessionPath,
        ftpVideoPath:   videoPath,
        fileCount:      files.length,
        totalBytes,
        files
      });
    }

    return { ok: true, data: sessions };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    client.close();
  }
}

/**
 * Ingest selected sessions from the ATEM FTP to a local destination.
 *
 * Calls onProgress({ type, session, file, fileIndex, fileTotal, logId, camInfo?, destPath?, error? })
 * after each significant event.
 *
 * Returns { ok, error? }
 */
async function ingestSessions(host, port = DEFAULT_PORT, sessions, destination, logIds, onProgress, cancelToken) {
  const client = makeClient();

  client.trackProgress(info => {
    // Per-byte progress on the currently downloading file — forward to caller
    onProgress({ type: 'file-bytes', bytes: info.bytes, bytesTotal: info.bytesOverall });
  });

  try {
    await client.access({ host, port });

    for (const session of sessions) {
      const logId = logIds[session.name];
      const sessionDest = path.join(destination, session.name);

      for (let i = 0; i < session.files.length; i++) {
        if (cancelToken.canceled) {
          return { ok: false, error: 'canceled' };
        }

        const file = session.files[i];
        const camInfo = parseCameraInfo(file.name);
        const camFolder = camInfo ? camFolderName(camInfo.camNumber) : 'Unknown';
        const fileDestDir  = path.join(sessionDest, camFolder);
        const fileDestPath = path.join(fileDestDir, file.name);

        onProgress({
          type:      'file-start',
          session:   session.name,
          file:      file.name,
          fileIndex: i,
          fileTotal: session.files.length,
          size:      file.size,
          logId,
          camInfo
        });

        // Skip if already on disk with matching size.
        try {
          const stat = fs.statSync(fileDestPath);
          if (file.size > 0 && stat.size === file.size) {
            onProgress({ type: 'file-skipped', session: session.name, file: file.name, fileIndex: i, fileTotal: session.files.length, logId });
            continue;
          }
        } catch (_err) { /* doesn't exist yet */ }

        try {
          fs.mkdirSync(fileDestDir, { recursive: true });
          const remotePath = `${session.ftpVideoPath}/${file.name}`;
          await client.downloadTo(fileDestPath, remotePath);

          onProgress({
            type:       'file-done',
            session:    session.name,
            file:       file.name,
            fileIndex:  i,
            fileTotal:  session.files.length,
            destPath:   fileDestPath,
            logId,
            camInfo,
            size:       file.size
          });
        } catch (err) {
          onProgress({
            type:      'file-error',
            session:   session.name,
            file:      file.name,
            fileIndex: i,
            fileTotal: session.files.length,
            logId,
            error:     err.message
          });
        }
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    client.trackProgress(); // clear tracker
    client.close();
  }
}

module.exports = { listSessions, ingestSessions, parseCameraInfo, camFolderName };
