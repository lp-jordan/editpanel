#!/usr/bin/env node
/**
 * Packages EditPanel with electron-builder.
 *
 * Run this on the Windows machine. electron-builder cannot reliably cross-build a
 * Windows installer from macOS (it needs Wine, and ffmpeg-static ships the host
 * platform's binary), so the Windows installer must be produced on Windows after
 * `npm install` (which fetches the Windows ffmpeg binary).
 *
 * Output goes to ./release by default. Set EP_RELEASE_OUT to write straight to the
 * shared NAS folder that LPOS watches, e.g. on Windows:
 *
 *   set "EP_RELEASE_OUT=N:\LPOS\editpanel dist" && npm run package
 *
 * electron-builder writes latest.yml LAST, so LPOS never picks up a build before
 * the .exe has finished copying — no separate copy step needed.
 */
import { spawnSync } from 'child_process';

const args = ['electron-builder'];

const outDir = process.env.EP_RELEASE_OUT?.trim();
if (outDir) {
  // Quote the value so a path containing spaces (e.g. "...\editpanel dist")
  // survives the shell. Backslashes are left as-is for Windows paths.
  args.push(`-c.directories.output="${outDir}"`);
  console.log(`[package] writing build output to: ${outDir}`);
}

const result = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env },
});

process.exit(result.status ?? 0);
