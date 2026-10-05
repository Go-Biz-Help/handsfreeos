#!/usr/bin/env node
/**
 * Builds the Chrome extension into dist/chrome: its three scripts bundled by esbuild, the panel's page and styles,
 * the icons, and manifest.json with the version from package.json. Load dist/chrome with "Load unpacked" on
 * chrome://extensions (README.md).
 *
 *   node scripts/build.mjs           build once
 *   node scripts/build.mjs --watch   build, then again on every change
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/chrome');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

/** The only site the extension works on, and the only one it asks for. */
const FACEBOOK = ['https://www.facebook.com/*', 'https://web.facebook.com/*'];
const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

const manifest = {
  manifest_version: 3,
  name: 'HandsFreeOS Social (test)',
  short_name: 'HFOS Social',
  version,
  description:
    'Reads the Facebook page you have open and shows what it found. A test build: it saves nothing and sends nothing.',
  minimum_chrome_version: '116',
  icons: ICONS,
  action: { default_title: 'HandsFreeOS Social', default_icon: ICONS },
  side_panel: { default_path: 'panel.html' },
  background: { service_worker: 'background.js' },
  // The side panel, its one setting, and loading the reader into Facebook tabs opened before the extension was.
  permissions: ['sidePanel', 'storage', 'scripting'],
  host_permissions: FACEBOOK,
  content_scripts: [{ matches: FACEBOOK, js: ['content.js'], run_at: 'document_idle' }],
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: {
    content: 'src/content.ts',
    background: 'src/background.ts',
    panel: 'src/panel/panel.ts',
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  charset: 'utf8',
  legalComments: 'none',
  // Readable, so anyone can check what it does: the stores allow that and forbid hiding it.
  minify: false,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'public'), out, { recursive: true });
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
  console.log(`Built HandsFreeOS Social ${version} in dist/chrome.`);
}
