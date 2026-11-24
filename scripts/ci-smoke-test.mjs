#!/usr/bin/env node
/**
 * CI smoke test for the real production web bundle (dist/).
 * Serves dist with the app's Content-Security-Policy from tauri.conf.json, opens the 5-track demo in headless
 * Chromium and checks that alphaTab actually renders the tablature (an SVG appears and "Rendering" goes away).
 *
 *   node scripts/ci-smoke-test.mjs [fixed|nonce] [screenshot.png]
 *
 * "fixed" serves the policy exactly as Tauri now sends it and must pass.
 * "nonce" adds a style-src nonce, which is what Tauri did before `dangerousDisableAssetCspModification`. It shows
 * the failure we fixed, and the script exits 0 either way in that mode.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const mode = process.argv[2] ?? 'fixed';
const shot = process.argv[3] ?? `ci-smoke-${mode}.png`;
const root = resolve('dist');
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
let directives = Object.entries(conf.app.security.csp).map(([k, v]) => `${k} ${v}`);
if (mode === 'nonce') directives = directives.map((d) => (d.startsWith('style-src') ? `${d} 'nonce-riffforgeci'` : d));
const csp = directives.join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.sf2': 'application/octet-stream',
  '.sf3': 'application/octet-stream',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    console.log(`[smoke:${mode}]   404 ${url.pathname}`);
    return void res.writeHead(404).end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(4173, '127.0.0.1', r));
console.log(`[smoke:${mode}] CSP: ${csp}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

let ok = false;
try {
  await page.goto('http://127.0.0.1:4173/index.html');
  await page.getByRole('button', { name: /Full Rock\/Metal Band/ }).click();
  await page.waitForFunction(
    () => !!document.querySelector('.at-surface svg') && !document.body.innerText.includes('Rendering'),
    null,
    { timeout: 30_000 },
  );
  const svgs = await page.evaluate(() => document.querySelectorAll('.at-surface svg').length);
  const glyphs = await page.evaluate(() => document.querySelectorAll('.at-surface svg text, .at-surface svg path').length);
  console.log(`[smoke:${mode}] rendered: ${svgs} SVG partial(s), ${glyphs} glyph elements`);
  ok = svgs > 0 && glyphs > 50;
} catch (err) {
  console.log(`[smoke:${mode}] tablature did NOT render: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
}
await page.screenshot({ path: shot, fullPage: false });
for (const p of problems.slice(0, 15)) console.log(`[smoke:${mode}]   ${p}`);
await browser.close();
server.close();

if (mode === 'fixed' && !ok) {
  console.error(`[smoke:${mode}] FAILED`);
  process.exit(1);
}
console.log(`[smoke:${mode}] ${ok ? 'PASSED' : 'failed as expected for this mode'}`);
