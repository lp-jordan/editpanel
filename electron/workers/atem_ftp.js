'use strict';

/**
 * atem_ftp.js — FTP access layer for ATEM ISO Extreme SDI.
 *
 * Used directly in main.js (not a worker subprocess).
 *
 * ATEM FTP folder structure (verified against live LEADERPASS2 drive,
 * 2026-05-25):
 *   /
 *   └── <drive-name>/                     ← one drive, name irrelevant
 *       └── <SessionName>/                ← e.g. "ACM_ACM_Shorts_05-22-26"
 *           ├── <Session>.drp             ← ignored
 *           ├── *_Program_*.mp4           ← ignored (program mix)
 *           ├── Audio Source Files/       ← ignored
 *           └── Video ISO Files/
 *               ├── <SessionName> CAM 1 01.mp4   ← CAM {n} {take}
 *               ├── <SessionName> CAM 1 02.mp4
 *               ├── <SessionName> CAM 2 01.mp4
 *               ├── ._<SessionName> CAM 1 01.mp4 ← AppleDouble metadata, skip
 *               └── ...
 *
 * NOTE on naming: the live drive produces `.mp4` files with a SPACE before
 * "CAM" and zero-padded take numbers. Earlier docs in this file assumed
 * `.mov` with underscore-CAM — that was wrong, never matched anything.
 */

const { Client } = require('basic-ftp');
const fs = require('fs');
const path = require('path');

const VIDEO_ISO_FOLDER = 'Video ISO Files';
const DEFAULT_PORT = 21;
// Both .mov and .mp4 in case ATEM firmware/format changes; current real
// drive emits .mp4 exclusively, the previous .mov-only filter dropped
// every file silently and made the overlay claim "No sessions found".
const VIDEO_EXT_RE = /\.(mov|mp4)$/i;
// macOS metadata sidecars ("._FileName.mp4") — never video, always skip.
const APPLE_DOUBLE_RE = /^\._/;

/**
 * Parse camera number and take number from an ATEM video filename.
 * Pattern: anything + [space-or-underscore] + "CAM {camNum} {takeNum}.ext"
 * e.g. "Session_05-20-26 CAM 1 01.mp4" → { camNumber: 1, takeNumber: 1 }
 *      "Session_CAM 2 02.mov"          → { camNumber: 2, takeNumber: 2 }
 *
 * The live drive uses space-CAM with zero-padded take numbers; the old
 * `_CAM` regex assumed an underscore separator and missed every file.
 */
function parseCameraInfo(filename) {
  const match = filename.match(/[\s_]CAM (\d+) (\d+)\./i);
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
  const client = new Client(10000); // 10-second socket timeout
  // NOTE: do NOT route basic-ftp `verbose` into the console. The library
  // dumps the entire LIST reply (every file on the drive) for each
  // directory walked, which on a multi-session ATEM drive is tens of
  // thousands of lines — enough to fill the SlideoutConsole and the
  // launching terminal in seconds. If you need protocol-level FTP
  // debugging, set `client.ftp.verbose = console.log` locally; do not
  // forward it to the renderer.
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
 *
 * onLog (optional): (msg: string) => void — called for each connect stage so
 * the UI can show progress instead of a 10-second silent hang.
 */
async function listSessions(host, port = DEFAULT_PORT, onLog = null) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const client = makeClient();
  try {
    log(`access → ${host}:${port}`);
    await client.access({ host, port, user: '', password: '' });
    log('access ok, scanning sessions');

    // Root contains drive folder(s) — name is irrelevant, use first one found.
    const rootItems = await client.list('/');
    const drives = rootItems.filter(i => i.isDirectory);
    if (drives.length === 0) {
      return { ok: false, error: 'No drive folder found on ATEM FTP root.' };
    }

    const drivePath = `/${drives[0].name}`;
    log(`drive: ${drivePath}`);
    const sessionItems = await client.list(drivePath);
    const sessionDirs = sessionItems.filter(i => i.isDirectory);

    let kept = 0;
    let skippedNoFolder = 0;
    let skippedNoVideos = 0;
    const sessions = [];
    for (const dir of sessionDirs) {
      const sessionPath = `${drivePath}/${dir.name}`;
      const videoPath   = `${sessionPath}/${VIDEO_ISO_FOLDER}`;

      let videoItems;
      try {
        videoItems = await client.list(videoPath);
      } catch (_err) {
        // No Video ISO Files folder — skip this session.
        skippedNoFolder++;
        continue;
      }

      const videoFiles = videoItems.filter(i => i.isFile);
      const files = videoFiles
        .filter(i => VIDEO_EXT_RE.test(i.name) && !APPLE_DOUBLE_RE.test(i.name))
        .map(i => ({ name: i.name, size: i.size || 0 }));
      const totalBytes = files.reduce((s, f) => s + f.size, 0);

      if (files.length === 0) {
        // Log what we DID see so the user can debug filename mismatches
        // without having to flip on protocol-level FTP verbose mode.
        log(`session "${dir.name}": 0 matching videos (${videoFiles.length} non-video entries in folder)`);
        skippedNoVideos++;
        continue;
      }

      kept++;
      sessions.push({
        name:           dir.name,
        ftpSessionPath: sessionPath,
        ftpVideoPath:   videoPath,
        fileCount:      files.length,
        totalBytes,
        files
      });
    }

    const skipDetail = (skippedNoFolder || skippedNoVideos)
      ? ` (${skippedNoFolder} no Video ISO Files folder, ${skippedNoVideos} no matching videos)`
      : '';
    log(`scanned ${sessionDirs.length} dirs: ${kept} sessions${skipDetail}`);
    return { ok: true, data: sessions };
  } catch (err) {
    log(`error: ${err.code ? `[${err.code}] ` : ''}${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
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
    await client.access({ host, port, user: '', password: '' });

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
            // Include destPath + camInfo so an already-on-disk file can still be
            // imported into Resolve (the import step needs the local path + camera).
            onProgress({ type: 'file-skipped', session: session.name, file: file.name, fileIndex: i, fileTotal: session.files.length, destPath: fileDestPath, camInfo, logId });
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
