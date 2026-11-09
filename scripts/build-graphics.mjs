#!/usr/bin/env node
/**
 * Prepares the Graphics engine in vendor/graphics (not committed):
 *   host/       the prebuilt Remotion project (packaged apps must not bundle at run time)
 *   kit.js      the live preview, embedded into its sandboxed iframe
 *   browser/    Chrome Headless Shell
 *   compositor/ Remotion's native binaries for this platform
 * Runs after `npm install` and before packaging. Skips when already built for this version.
 */
import fs from 'fs';
import path from 'path';
import {createRequire} from 'module';
import {fileURLToPath} from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'vendor', 'graphics');
const require_ = createRequire(path.join(root, 'package.json'));
const version = require_('remotion/package.json').version;
const stampFile = path.join(out, 'BUILD');
const stamp = `${version} ${process.platform} ${process.arch}`;
const sources = ['graphics-src/runtime.tsx', 'graphics-src/Root.tsx', 'graphics-src/index.ts', 'graphics-src/kit.tsx'];
const newest = Math.max(...sources.map((f) => fs.statSync(path.join(root, f)).mtimeMs));

const fresh = fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp && fs.statSync(stampFile).mtimeMs >= newest;
if (fresh && !process.argv.includes('--force')) {
  console.log('[graphics] engine is up to date');
  process.exit(0);
}

const {bundle} = require_('@remotion/bundler');
const {ensureBrowser} = require_('@remotion/renderer');
const esbuild = require_('esbuild');

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

console.log('[graphics] building the render host');
await bundle({entryPoint: path.join(root, 'graphics-src/index.ts'), outDir: path.join(out, 'host'), enableCaching: false});

console.log('[graphics] building the preview');
await esbuild.build({
  entryPoints: [path.join(root, 'graphics-src/kit.tsx')],
  bundle: true, format: 'iife', minify: true, platform: 'browser', target: 'chrome120',
  outfile: path.join(out, 'kit.js'), define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'error'
});

console.log('[graphics] preparing the browser');
await ensureBrowser();
const platform = process.platform === 'win32' ? 'win64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
const browserFrom = path.join(root, 'node_modules/.remotion/chrome-headless-shell', platform, `chrome-headless-shell-${platform}`);
fs.cpSync(browserFrom, path.join(out, 'browser'), {recursive: true, verbatimSymlinks: true});

const compositor = process.platform === 'win32' ? 'win32-x64-msvc' : `darwin-${process.arch}`;
fs.cpSync(path.join(root, 'node_modules/@remotion', `compositor-${compositor}`), path.join(out, 'compositor'), {recursive: true, verbatimSymlinks: true});

fs.writeFileSync(stampFile, stamp);
console.log('[graphics] done');
