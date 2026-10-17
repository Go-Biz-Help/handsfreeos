#!/usr/bin/env node
/**
 * The store listings' marketing images: each real screenshot in apps/mobile/store/assets/screenshots/ set in a phone,
 * under a headline, on the brand's blue, plus a Play feature graphic with words on it.
 *
 *   node scripts/store-marketing.mjs              write every image to apps/mobile/store/assets/marketing/
 *   node scripts/store-marketing.mjs ios-5        write only the images whose name starts with "ios-5"
 *
 * Run it by hand when a screenshot or a headline changes; nothing in CI depends on it, because the only thing checked
 * in is its output. The words live in SLIDES below, so a headline is changed here and the images made again, never
 * edited in a picture.
 *
 * It draws each image as a web page in Chromium and saves it at exactly the size its store asks for: 1320×2868 for
 * the App Store's 6.9" iPhone slot (`ios-`), 1206×2622 for its 6.1"/6.3" slot (`ios63-`), 1080×1920 for Play's
 * phone screenshots (`android-`), 1024×500 for Play's feature graphic, and the App Store's product page header in
 * both its sizes (`app-store-header-`).
 * Playwright comes from apps/web (`@playwright/test`, after `pnpm install`; `pnpm --filter @hfos/web exec playwright
 * install chromium` if it has no browser yet), or from a global `playwright`. The brand font, Hanken Grotesk, is
 * fetched from Google Fonts with curl into the system's temp folder, each weight from its own file, so the 800
 * headlines are never faked from the 500 lines under them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(root, 'apps/mobile/store/assets/screenshots');
const OUT = join(root, 'apps/mobile/store/assets/marketing');
const MARK = join(root, 'design/brand/handsfreeos-icon.png');

/** [screenshot key, headline (a <br> where the line breaks, so every slide has two), the line under it]. */
const SLIDES = [
  [
    '1-home',
    'Know what<br>needs you first',
    'Hot leads and waiting customers at the top, with one tap to call or reply.',
  ],
  [
    '2-pipeline',
    'Every lead,<br>one tap from won',
    'See what each job is worth and what happens next.',
  ],
  [
    '3-customer',
    'One customer,<br>one screen',
    'Call, text, email, book or add a note without hunting.',
  ],
  ['4-calendar', 'Your whole day<br>at a glance', 'Every visit, who it’s with, and where to go.'],
  [
    '5-invoice',
    'Invoice right<br>from the truck',
    'Check the total and send it before you pull away.',
  ],
  [
    '5b-record-cash',
    'Paid in cash?<br>Log it on the spot',
    'Record cash or a check, even with no signal.',
  ],
  [
    '6-offline-queue',
    'Works with<br>no signal',
    'Crawl space or basement, your changes wait and send when you’re back.',
  ],
  [
    '7-money-list',
    'Know what<br>you’re owed',
    'Outstanding, overdue and collected, all in one place.',
  ],
];

/** Per store, in pixels at the size the store asks for. The phone runs off the bottom on purpose. */
const PLATFORMS = {
  ios: {
    W: 1320,
    H: 2868,
    shot: [1320, 2868],
    padTop: 168,
    head: 112,
    sub: 50,
    gap: 34,
    textW: 1200,
    subW: 1000,
    phoneW: 1040,
    phoneTop: 720,
    bezel: 26,
    radius: 156,
    screenRadius: 130,
    camera: 'island',
  },
  android: {
    W: 1080,
    H: 1920,
    shot: [1080, 1920],
    padTop: 104,
    head: 84,
    sub: 38,
    gap: 24,
    textW: 1000,
    subW: 800,
    phoneW: 820,
    phoneTop: 520,
    bezel: 20,
    radius: 96,
    screenRadius: 78,
    camera: 'hole',
  },
};
/**
 * App Store Connect also asks for the 6.1"/6.3" iPhone slot, at 1206×2622. The same 6.9" screenshots fit it (the two
 * are the same shape to within a pixel), so this is the iPhone layout drawn smaller rather than an image shrunk.
 */
PLATFORMS.ios63 = Object.fromEntries(
  Object.entries(PLATFORMS.ios).map(([k, v]) => [
    k,
    typeof v === 'number' ? Math.round((v * 1206) / 1320) : v,
  ]),
);
Object.assign(PLATFORMS.ios63, { W: 1206, H: 2622, shot: [1320, 2868], source: 'ios' });

/** The mark's own blues (design/brand), deepening from top right to bottom left. */
const BLUE = `
  radial-gradient(120% 60% at 85% 0%, rgba(80, 190, 255, 0.55) 0%, rgba(80, 190, 255, 0) 60%),
  radial-gradient(90% 50% at 0% 100%, rgba(10, 60, 200, 0.55) 0%, rgba(10, 60, 200, 0) 70%),
  linear-gradient(165deg, #2a8cfc 0%, #1f74f2 45%, #1758dc 100%)`;

function loadChromium() {
  for (const from of [join(root, 'apps/web/package.json'), join(root, 'package.json')]) {
    for (const name of ['@playwright/test', 'playwright']) {
      try {
        return createRequire(from)(name).chromium;
      } catch {
        // Try the next place.
      }
    }
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, 'noop.js'))('playwright').chromium;
  } catch {
    throw new Error(
      'Playwright is missing. Run `pnpm install` at the repository root, then try again.',
    );
  }
}

function fetchFont(dir) {
  const css = execFileSync(
    'curl',
    [
      '-fsS',
      '-A',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@500;700;800&display=swap',
    ],
    { encoding: 'utf8' },
  );
  // Google answers with one block per subset and weight: a variable file serving every weight, or one file per
  // weight. Either way each Latin block becomes an @font-face of its own, with the weight Google gave it.
  const faces = [...css.matchAll(/\/\* latin \*\/\s*@font-face \{([^}]*)\}/g)].map(
    ([, block], i) => {
      const weight = block.match(/font-weight:\s*([^;]+);/)?.[1] ?? '400';
      const url = block.match(/url\((https:[^)]+)\)/)?.[1];
      if (!url) throw new Error('Google Fonts sent a Hanken Grotesk block with no file in it.');
      const file = join(dir, `hanken-${i}.woff2`);
      execFileSync('curl', ['-fsS', '-o', file, url]);
      return `@font-face { font-family: 'Hanken'; src: url('${pathToFileURL(file).href}') format('woff2'); font-weight: ${weight}; }`;
    },
  );
  if (faces.length === 0)
    throw new Error('Google Fonts sent no Hanken Grotesk. Check the connection and try again.');
  return faces.join('\n');
}

const page = (W, H, font, css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${font}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: ${BLUE}; font-family: 'Hanken', sans-serif; color: #fff; position: relative;
         -webkit-font-smoothing: antialiased; }
  .screen { position: relative; overflow: hidden; background: #fff; }
  .screen img { display: block; width: 100%; height: 100%; }
  .cam { position: absolute; left: 50%; transform: translateX(-50%); background: #000; border-radius: 999px; }
  ${css}</style></head><body>${body}</body></html>`;

/** The iPhone's Dynamic Island or an Android punch-hole camera, scaled to a screen `s` times the screenshot. */
const camera = (kind, s) =>
  kind === 'island'
    ? `<div class="cam" style="top:${Math.round(33 * s)}px;width:${Math.round(376 * s)}px;height:${Math.round(110 * s)}px"></div>`
    : `<div class="cam" style="top:${Math.round(28 * s)}px;width:${Math.round(36 * s)}px;height:${Math.round(36 * s)}px"></div>`;

function slide(p, font, file, head, sub) {
  const screenW = p.phoneW - p.bezel * 2;
  const screenH = Math.round((screenW * p.shot[1]) / p.shot[0]);
  const css = `
    .text { position:absolute; left:50%; top:${p.padTop}px; width:${p.textW}px; transform:translateX(-50%); text-align:center; }
    h1 { font-weight:800; font-size:${p.head}px; line-height:1.04; letter-spacing:-0.025em; }
    p { margin:${p.gap}px auto 0; max-width:${p.subW}px; font-weight:500; font-size:${p.sub}px; line-height:1.3;
        color:rgba(255,255,255,0.88); text-wrap:balance; }
    .phone { position:absolute; left:50%; top:${p.phoneTop}px; width:${p.phoneW}px; height:${screenH + p.bezel * 2}px;
             transform:translateX(-50%); background:#0c0f15; border-radius:${p.radius}px; padding:${p.bezel}px;
             box-shadow: 0 0 0 ${Math.round(p.bezel * 0.18)}px #2b313c inset,
                         0 ${Math.round(p.W * 0.05)}px ${Math.round(p.W * 0.1)}px rgba(6, 22, 70, 0.42),
                         0 ${Math.round(p.W * 0.01)}px ${Math.round(p.W * 0.025)}px rgba(6, 22, 70, 0.3); }
    .screen { width:${screenW}px; height:${screenH}px; border-radius:${p.screenRadius}px; }`;
  const body = `
    <div class="text"><h1>${head}</h1><p>${sub}</p></div>
    <div class="phone"><div class="screen"><img src="${pathToFileURL(join(SHOTS, file)).href}">${camera(p.camera, screenW / p.shot[0])}</div></div>`;
  return page(p.W, p.H, font, css, body);
}

function featureGraphic(font) {
  const W = 1024,
    H = 500,
    phoneW = 300,
    bezel = 9,
    screenW = phoneW - bezel * 2;
  const screenH = Math.round((screenW * 2868) / 1320);
  const css = `
    .brand { position:absolute; left:64px; top:92px; display:flex; align-items:center; gap:14px; }
    .chip { width:56px; height:56px; border-radius:15px; background:#fff; display:grid; place-items:center;
            box-shadow:0 6px 18px rgba(6,22,70,0.25); }
    .chip img { width:40px; height:40px; }
    .name { font-weight:700; font-size:30px; letter-spacing:-0.01em; }
    h1 { position:absolute; left:64px; top:172px; width:560px; font-weight:800; font-size:62px; line-height:1.02; letter-spacing:-0.03em; }
    p { position:absolute; left:64px; top:316px; width:520px; font-weight:500; font-size:24px; line-height:1.35;
        color:rgba(255,255,255,0.88); text-wrap:balance; }
    .phone { position:absolute; left:${W - phoneW - 70}px; top:58px; width:${phoneW}px; height:${screenH + bezel * 2}px;
             background:#0c0f15; border-radius:48px; padding:${bezel}px; transform:rotate(-4deg);
             box-shadow:0 30px 60px rgba(6,22,70,0.45); }
    .screen { width:${screenW}px; height:${screenH}px; border-radius:40px; }`;
  const body = `
    <div class="brand"><div class="chip"><img src="${pathToFileURL(MARK).href}"></div><div class="name">HandsFreeOS</div></div>
    <h1>Run your day from your truck.</h1>
    <p>Texts, calls, jobs and invoices in one app. Works with no signal.</p>
    <div class="phone"><div class="screen"><img src="${pathToFileURL(join(SHOTS, 'ios-1-home.png')).href}">${camera('island', screenW / 1320)}</div></div>`;
  return page(W, H, font, css, body);
}

/**
 * The App Store's product page header (App Store Connect → Header and Search Results). Apple takes either a 21:9
 * header alone, 3840×1646, or one 16:9 image, 5244×2950, that it crops to 21:9 for the header and to 3:2 for search
 * results. So the design is drawn once in a 3840×1646 box, and for the 16:9 image that box is scaled into the part
 * both crops keep (the middle 4425×2247), with the blue running out to the edges. Its bottom is left quiet, because
 * the App Store puts the app's name over the bottom of the header.
 */
const ART = { W: 3840, H: 1646 };
function productPageHeader(font, W, H) {
  const k = W === ART.W ? 1 : Math.min(4425 / ART.W, 2247 / ART.H);
  const x = Math.round((W - ART.W * k) / 2),
    y = Math.round((H - ART.H * k) / 2);
  const phone = (file, left, top, width, turn, z) => {
    const bezel = Math.round(width * 0.027),
      screenW = width - bezel * 2;
    const screenH = Math.round((screenW * 2868) / 1320);
    return `<div class="phone" style="left:${left}px;top:${top}px;width:${width}px;height:${screenH + bezel * 2}px;
      padding:${bezel}px;border-radius:${Math.round(width * 0.15)}px;transform:rotate(${turn}deg);z-index:${z}">
      <div class="screen" style="width:${screenW}px;height:${screenH}px;border-radius:${Math.round(width * 0.125)}px">
      <img src="${pathToFileURL(join(SHOTS, file)).href}">${camera('island', screenW / 1320)}</div></div>`;
  };
  const css = `
    .art { position:absolute; left:${x}px; top:${y}px; width:${ART.W}px; height:${ART.H}px; transform:scale(${k}); transform-origin:0 0; }
    .brand { position:absolute; left:300px; top:290px; display:flex; align-items:center; gap:40px; }
    .chip { width:150px; height:150px; border-radius:40px; background:#fff; display:grid; place-items:center;
            box-shadow:0 16px 48px rgba(6,22,70,0.25); }
    .chip img { width:108px; height:108px; }
    .name { font-weight:700; font-size:96px; letter-spacing:-0.01em; }
    h1 { position:absolute; left:300px; top:500px; width:1800px; font-weight:800; font-size:214px; line-height:1.02; letter-spacing:-0.03em; }
    p { position:absolute; left:300px; top:978px; width:1500px; font-weight:500; font-size:78px; line-height:1.3;
        color:rgba(255,255,255,0.88); text-wrap:balance; }
    .phone { position:absolute; background:#0c0f15;
             box-shadow: 0 0 0 4px #2b313c inset, 0 90px 160px rgba(6,22,70,0.42), 0 20px 50px rgba(6,22,70,0.3); }`;
  const body = `<div class="art">
    <div class="brand"><div class="chip"><img src="${pathToFileURL(MARK).href}"></div><div class="name">HandsFreeOS</div></div>
    <h1>Run your day<br>from your truck.</h1>
    <p>Texts, calls, jobs and invoices in one app. Works with no signal.</p>
    ${phone('ios-4-calendar.png', 2130, 330, 520, -7, 1)}
    ${phone('ios-7-money-list.png', 3070, 330, 520, 7, 1)}
    ${phone('ios-1-home.png', 2560, 190, 600, 0, 2)}
  </div>`;
  return page(W, H, font, css, body);
}

const only = process.argv[2];
const jobs = [];
for (const [platform, p] of Object.entries(PLATFORMS))
  for (const [key, head, sub] of SLIDES) {
    const name = `${platform}-${key}`;
    const shot = `${p.source ?? platform}-${key}.png`;
    if (!only || name.startsWith(only))
      jobs.push({ name, shot, W: p.W, H: p.H, html: (f) => slide(p, f, shot, head, sub) });
  }
if (!only || 'play-feature-graphic'.startsWith(only))
  jobs.push({ name: 'play-feature-graphic', W: 1024, H: 500, html: featureGraphic });
for (const [W, H] of [
  [3840, 1646],
  [5244, 2950],
]) {
  const name = `app-store-header-${W}x${H}`;
  if (!only || name.startsWith(only))
    jobs.push({ name, W, H, html: (f) => productPageHeader(f, W, H) });
}
for (const job of jobs)
  if (job.shot && !existsSync(join(SHOTS, job.shot)))
    throw new Error(`There is no screenshot ${job.shot} in ${SHOTS}.`);

mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'hfos-marketing-'));
const browser = await loadChromium().launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
try {
  const font = fetchFont(work);
  for (const job of jobs) {
    const tab = await browser.newPage({
      viewport: { width: job.W, height: job.H },
      deviceScaleFactor: 1,
    });
    const html = join(work, `${job.name}.html`);
    writeFileSync(html, job.html(font));
    await tab.goto(pathToFileURL(html).href);
    await tab.evaluate(() => document.fonts.ready);
    await tab.screenshot({ path: join(OUT, `${job.name}.png`) });
    await tab.close();
    console.log(`wrote apps/mobile/store/assets/marketing/${job.name}.png (${job.W}×${job.H})`);
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
