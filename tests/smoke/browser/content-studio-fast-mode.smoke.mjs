// Opt-in browser acceptance of both Content Studio entry paths: the REAL component in headless Chrome,
// talking to local endpoints that run the REAL owner-route service (spec builder, export gate, Satori
// carousel, child-process Remotion Reel and output gates). Only the owner-scoped Supabase client is a
// local fixture adapter, and the media are SYNTHETIC test patterns (not food).
//
//   node tests/smoke/browser/content-studio-fast-mode.smoke.mjs
//
// Evidence and screenshots: outputs/fast-mode-acceptance/ (ignored).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import sharp from "sharp";
import { openBrowser } from "@remotion/renderer";
import { screenshot } from "../../../node_modules/@remotion/renderer/dist/puppeteer-screenshot.js";

import { generateCarouselSlide, generateReel } from "../../../src/lib/content-studio/fast-mode-service.ts";
import { readStoredZip } from "../../../src/lib/content-studio/export-output.ts";
import { renderReelOnHost } from "../../../src/lib/content-studio/reel-host.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, "outputs/fast-mode-acceptance");
mkdirSync(output, { recursive: true });

// --- synthetic media + owner-scoped fixture rows ----------------------------------------------------
const colours = ["#7a4a2a", "#c08850", "#5d6b3a", "#a33f2a", "#3b4f6b", "#6b3b5f", "#222222"];
const rows = colours.map((colour, i) => ({
  id: `p${i + 1}`,
  product_id: i === 6 ? "other-product" : "fm-product",
  media_type: "photo",
  storage_bucket: "product-media",
  storage_path: `p${i + 1}.jpg`,
  original_filename: `pattern-${i + 1}.jpg`,
  mime_type: "image/jpeg",
  file_size_bytes: 1000,
  width: 1200,
  height: 1500,
  duration_ms: null,
  created_at: `2026-10-14T0${i}:00:00.000Z`,
}));
const bytes = new Map();
for (const [i, row] of rows.entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500"><rect width="100%" height="100%" fill="${colours[i]}"/><circle cx="600" cy="750" r="${200 + i * 40}" fill="#ffffff" opacity="0.35"/></svg>`;
  bytes.set(row.storage_path, await sharp(Buffer.from(svg)).jpeg().toBuffer());
}

let address = "";
const products = [{ id: "fm-product", name: "Revel Bars" }, { id: "other-product", name: "Brownies" }];
const ownerClient = {
  from(table) {
    if (table === "products") {
      return { select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => ({ data: products.find((p) => p.id === id) ?? null, error: null }) }) }) };
    }
    return { select: () => ({ in: async (_c, ids) => ({ data: rows.filter((r) => ids.includes(r.id)), error: null }) }) };
  },
  storage: {
    from: () => ({
      download: async (p) => ({ data: new Blob([bytes.get(p)]), error: null }),
      createSignedUrl: async (p) => ({ data: { signedUrl: `${address}/media?path=${encodeURIComponent(p)}` }, error: null }),
    }),
  },
};

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { CreateNow } from './src/components/create-now';
// Capture exports: the exact bytes the Export button hands to the browser.
window.__downloads = [];
Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.__copied = value; } } });
HTMLAnchorElement.prototype.click = function () {
  const name = this.download;
  fetch(this.href).then(r => r.arrayBuffer()).then(b => { let s = ''; new Uint8Array(b).forEach(x => s += String.fromCharCode(x)); window.__downloads.push({ name, base64: btoa(s) }); });
};
function Studio() {
  const [jobId, setJobId] = useState(new URLSearchParams(location.search).get('job'));
  return <CreateNow jobId={jobId} onJobIdChange={setJobId} onExit={null} products={${JSON.stringify(products)}} />;
}
createRoot(document.getElementById('root')).render(
  <Studio />
);
`;
// A local Supabase adapter is the only replaced module. Planning components, validation,
// handoff, offer/media UI and production services all run their real code.
const fixtureModule = `
const params = new URLSearchParams(location.search);
const format = params.get('format') || 'carousel';
const jobId = '11111111-1111-4111-8111-111111111111';
const content = {
  schemaVersion: 'v2', format, subject: 'Revel Bars', angle: 'Freshly baked',
  hook: 'See the layers', headline: 'Revel Bars', caption: 'Order a box for ₱170.', cta: 'Message us',
  platformVariants: [{ platform: 'instagram', caption: 'Only ₱180.', hashtags: [] }],
  metadata: { generatedFromOpportunity: null, generatorVersion: '2', sourceCreativeJobId: jobId,
    sourceWorker: 'creative_ai', sourceJobResultSchemaVersion: 'v2', formatChosenBy: 'ai',
    formatRationale: 'Shows the layers.', subjectSource: 'stated', subjectGrounding: null },
  ...(format === 'carousel' ? { slides: [{ heading: 'Layers', body: 'Chocolate and oats', visualDirection: 'Close photo' }] }
    : format === 'reel' ? { shots: [{ direction: 'Show the bars', onScreenText: null }], spokenScript: null, audioDirection: 'Kitchen sounds', targetDurationSeconds: 11 }
    : format === 'photo' ? { visualDirection: 'Overhead photo', overlayText: null }
    : { frames: [{ visualDirection: 'Show bars', text: 'Fresh today' }], interaction: null }),
};
const time = '2026-10-14T00:00:00Z';
const job = { id: jobId, opportunity_id: null, intent: params.has('noProduct') ? {} : { productId: 'fm-product' },
  status: 'completed', worker_type: 'creative_ai', result: {}, created_at: time, updated_at: time };
const pkg = { id: 'fixture-package', creative_job_id: jobId, status: 'ready', schema_version: 'v2', content, created_at: time, updated_at: time };
window.__aiCalls = [];
window.__inserted = [];
export const isSupabaseConfigured = true;
export const supabase = {
  auth: { async getSession() { return { data: { session: { access_token: 'owner-test-token' } } }; } },
  from(table) {
    if (table === 'creative_jobs' || table === 'creative_packages') window.__aiCalls.push(table);
    let data = table === 'creative_jobs' ? [job] : table === 'creative_packages' ? [pkg] : table === 'product_media' ? ${JSON.stringify(rows)} : [];
    const q = {
      select() { return q; },
      insert(row) { window.__inserted.push({ table, row }); job.intent = row.intent; return q; },
      eq(c, v) { data = data.filter(r => r[c] === v); return q; },
      is(c, v) { return q.eq(c, v); },
      order() { return q; }, limit() { return q; },
      async maybeSingle() { return { data: data[0] || null, error: null }; },
      async single() { return params.has('aiOff') ? { data: null, error: { message: 'Planning is unavailable' } } : { data: data[0] || null, error: null }; },
      then(resolve) { resolve({ data, error: null }); },
    }; return q;
  },
  storage: { from() { return { async createSignedUrl(p) { return { data: { signedUrl: '/media?path=' + encodeURIComponent(p) }, error: null }; } }; } },
};
`;
await build({ plugins: [{ name: 'local-owner-fixture', setup(b) {
  b.onResolve({ filter: /(?:^|\/)supabase$/ }, () => ({ path: 'owner-fixture', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixtureModule, loader: 'js' }));
} }], stdin: { contents: entry, resolveDir: root, loader: "jsx" }, outfile: path.join(output, "app.js"), bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": "undefined", "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": "undefined" } });
const css = await postcss([tailwind({ base: root })]).process(readFileSync(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
writeFileSync(path.join(output, "app.css"), css.css);

const calls = { carousel: 0, reel: 0 };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://local.test");
  const readBody = async () => { const chunks = []; for await (const c of request) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString("utf8")); };
  if (url.pathname.startsWith("/api/") && request.headers.authorization !== "Bearer owner-test-token") { response.writeHead(401); response.end(); return; }
  if (url.pathname === "/api/content-studio/carousel" && request.method === "POST") {
    calls.carousel += 1;
    const result = await generateCarouselSlide(ownerClient, await readBody());
    if (!result.ok) { response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify({ message: result.message })); return; }
    response.writeHead(200, { "content-type": "image/png" }); response.end(Buffer.from(result.png)); return;
  }
  if (url.pathname === "/api/content-studio/reel" && request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ available: true })); return; }
  if (url.pathname === "/api/content-studio/reel" && request.method === "POST") {
    calls.reel += 1;
    const result = await generateReel(ownerClient, await readBody(), { available: () => true, render: (campaign) => renderReelOnHost(campaign, root) });
    if (!result.ok) { response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify({ message: result.message })); return; }
    response.writeHead(200, { "content-type": "video/mp4" }); response.end(Buffer.from(result.mp4)); return;
  }
  if (url.pathname === "/media") { response.setHeader("content-type", "image/jpeg"); response.end(bytes.get(url.searchParams.get("path"))); return; }
  if (url.pathname === "/app.js" || url.pathname === "/app.css") {
    response.setHeader("content-type", url.pathname.endsWith("css") ? "text/css" : "application/javascript");
    response.end(readFileSync(path.join(output, url.pathname.slice(1)))); return;
  }
  if (url.pathname !== "/") { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><main style="max-width:1100px;margin:auto;padding:16px"><div id="root"></div></main><script src="/app.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
address = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await openBrowser("chrome", { browserExecutable: process.env.MEDIA_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe", chromiumOptions: { headless: true } });
  const page = await browser.newPage({ context: () => null, logLevel: "error", indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} });
  await page.setViewport({ width: 390, height: 1000, deviceScaleFactor: 1 });
  const wait = async (expression, tries = 600) => {
    for (let i = 0; i < tries; i++) { if (await page.evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
    throw new Error(`Timed out: ${expression}; visible: ${await page.evaluate("document.body.innerText")}`);
  };
  const setField = (selector, value) => page.evaluate((s, v) => {
    const el = document.querySelector(s);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
    setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector, value);
  const click = (text) => page.evaluate((t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t).click(), text);
  const buttonDisabled = (text) => page.evaluate((t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t).disabled, text);
  const noOverflow = async (label) => {
    for (const width of [320, 375, 390, 1280]) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true, `${label}: horizontal overflow at ${width}`);
      await screenshot({ page, type: "png", path: path.join(output, `${label}-${width}.png`), omitBackground: false, width, height: 1000, scale: 1 });
    }
    await page.setViewport({ width: 390, height: 1000, deviceScaleFactor: 1 });
  };

  await page.goto({ url: address + '/?aiOff=1', timeout: 30000 });
  await wait("!!document.querySelector('textarea')");
  await noOverflow("entry");
  assert.equal(await page.evaluate('window.__aiCalls.length'), 0);
  await click('Build with my photos');
  await wait("!!document.querySelector('section[aria-label=\"Create content\"]')");
  assert.equal(await page.evaluate('window.__inserted.length'), 0, 'manual entry needs no creative job');
  await click('Back to create content');
  await wait("!!document.querySelector('textarea')");
  // Exercise a failed assisted submission before entering manual mode: planning failure must
  // not hide or disable the manual action, and manual mode must not create another AI job.
  await setField('textarea', 'Show our bars');
  await click('Create content');
  await wait("document.body.innerText.includes('Planning is unavailable')");
  const aiCallsBeforeManual = await page.evaluate('window.__aiCalls.length');
  const insertsBeforeManual = await page.evaluate('window.__inserted.length');
  await click('Build with my photos');
  await wait("!!document.querySelector('section[aria-label=\"Create content\"]')");
  // Owner-facing words only.
  const visible = await page.evaluate("document.body.innerText");
  for (const word of ["Satori", "Resvg", "Remotion", "Asset Job", "Worker", "Renderer", "Storage path", "Codec"]) assert.equal(visible.toLowerCase().includes(word.toLowerCase()), false, `technical word "${word}" visible`);
  assert.equal(await buttonDisabled("Generate"), true);

  // Product selection: only that product's media is offered.
  await page.evaluate(() => { const s = document.querySelector("select"); s.value = "fm-product"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  await wait("document.querySelectorAll('button[aria-pressed]').length === 2 + 6");
  await wait("[...document.querySelectorAll('section img')].every(i => i.complete && i.naturalWidth > 0)");
  // Media Library selection in order.
  for (const id of [1, 2, 3, 4, 5]) await page.evaluate((n) => [...document.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").endsWith(`pattern-${n}.jpg`)).click(), id);
  await wait("document.querySelectorAll('button[aria-label^=\"Picked\"]').length === 5");
  assert.match(await page.evaluate("document.querySelector('button[aria-label^=\"Picked 4\"]').getAttribute('aria-label')"), /Picked 4: Price photo/);

  // Offer confirmation: Generate stays off until price, unit, CTA AND the confirmation are given.
  await setField("input[type=number]", "160");
  await setField("input[placeholder='2 pcs']", "2 pcs");
  await setField("input[placeholder='Message us to order']", "Message us to order");
  await wait("document.body.innerText.includes('Confirm the price')");
  assert.equal(await buttonDisabled("Generate"), true);
  await page.evaluate(() => document.querySelector("input[name=offer-confirmed]").click());
  await wait("!document.body.innerText.includes('Confirm the price')");

  // Media attestation: unchecked by default, required for Generate, and cleared by ANY change to the
  // picked media -- it covers exactly the set it was given for.
  const attested = () => page.evaluate("document.querySelector('input[name=media-attested]').checked");
  assert.equal(await attested(), false);
  await wait("document.body.innerText.includes('real pictures of your own food')");
  assert.equal(await buttonDisabled("Generate"), true);
  const attest = () => page.evaluate(() => document.querySelector("input[name=media-attested]").click());
  const pickPattern = (n) => page.evaluate((k) => [...document.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").endsWith(`pattern-${k}.jpg`)).click(), n);
  await attest();
  await wait("document.querySelector('input[name=media-attested]').checked && !document.body.innerText.includes('real pictures of your own food')");
  // Remove one item: attestation cleared.
  await pickPattern(5);
  await wait("!document.querySelector('input[name=media-attested]').checked");
  // Picking it again does not restore the attestation: the owner must attest again.
  await pickPattern(5);
  await wait("document.querySelectorAll('button[aria-label^=\"Picked\"]').length === 5");
  assert.equal(await attested(), false);
  assert.equal(await buttonDisabled("Generate"), true);
  await attest();
  // Replace the selection by changing product and back: cleared again.
  await page.evaluate(() => { const s = document.querySelector("select"); s.value = "other-product"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  await wait("!document.querySelector('input[name=media-attested]').checked");
  await page.evaluate(() => { const s = document.querySelector("select"); s.value = "fm-product"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  await wait("document.querySelectorAll('button[aria-pressed]').length === 2 + 6");
  for (const id of [1, 2, 3, 4, 5]) await pickPattern(id);
  await wait("document.querySelectorAll('button[aria-label^=\"Picked\"]').length === 5");
  assert.equal(await attested(), false);
  await attest();
  await wait("document.querySelector('input[name=media-attested]').checked");
  await noOverflow("form");

  // Error state from the server: a selling unit that cannot fit is refused with an owner message.
  await setField("input[placeholder='2 pcs']", "W".repeat(24));
  await page.evaluate(() => document.querySelector("input[name=offer-confirmed]").click());
  await click("Generate");
  await wait("document.querySelector('[role=alert]')?.innerText.includes('Shorten the selling unit')");
  await setField("input[placeholder='2 pcs']", "2 pcs");
  await page.evaluate(() => document.querySelector("input[name=offer-confirmed]").click());

  // Generate -> carousel preview of five 1080x1350 slides.
  await click("Generate");
  await wait("!!document.querySelector('section[aria-label=\"Preview\"]')");
  await wait("document.querySelectorAll('[aria-label=\"Slides\"] img').length === 5 && [...document.querySelectorAll('[aria-label=\"Slides\"] img')].every(i => i.complete && i.naturalWidth === 1080 && i.naturalHeight === 1350)");
  await click("Next"); await click("Next");
  await wait("document.body.innerText.includes('Slide 3 of 5')");
  await noOverflow("carousel-preview");

  // Export: carousel.zip holds exactly the previewed slides.
  const previewed = await page.evaluate(async () => Promise.all([...document.querySelectorAll('[aria-label="Slides"] img')].map(async (img) => {
    const b = new Uint8Array(await (await fetch(img.src)).arrayBuffer()); let s = ""; b.forEach((x) => (s += String.fromCharCode(x))); return btoa(s);
  })));
  await click("Export");
  await wait("window.__downloads.length === 1");
  const zipDownload = await page.evaluate("window.__downloads[0]");
  assert.equal(zipDownload.name, "carousel.zip");
  const unzipped = readStoredZip(new Uint8Array(Buffer.from(zipDownload.base64, "base64")));
  assert.deepEqual(unzipped.map((f) => f.name), ["carousel-01.png", "carousel-02.png", "carousel-03.png", "carousel-04.png", "carousel-05.png"]);
  unzipped.forEach((file, i) => assert.deepEqual(Buffer.from(file.bytes), Buffer.from(previewed[i], "base64"), `zip entry ${i + 1} differs from its preview`));
  for (const file of unzipped) writeFileSync(path.join(output, file.name), file.bytes);

  // Regenerate stays on preview; Back returns to the filled form.
  const before = calls.carousel;
  await click("Regenerate");
  await wait(`document.querySelectorAll('[aria-label="Slides"] img').length === 5 && !document.body.innerText.includes('Making it again')`);
  assert.equal(calls.carousel - before, 5);
  await click("Back");
  await wait("!!document.querySelector('section[aria-label=\"Create content\"]')");
  assert.equal(await page.evaluate("document.querySelector('input[type=number]').value"), "160");

  // Format selection -> Reel (real render of the same five stills), playable preview, MP4 export.
  await click("Reel");
  await wait("!document.body.innerText.includes('studio computer')", 20);
  await wait("!" + `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Generate").disabled`);
  await click("Generate");
  await wait("!!document.querySelector('video[aria-label=\"Reel preview\"]') && document.querySelector('video[aria-label=\"Reel preview\"]').readyState >= 1", 2400);
  const duration = await page.evaluate("document.querySelector('video[aria-label=\"Reel preview\"]').duration");
  assert.ok(duration >= 10 && duration <= 12, `reel preview duration ${duration}`);
  await page.evaluate(() => document.querySelector('video[aria-label="Reel preview"]').play());
  await wait("document.querySelector('video[aria-label=\"Reel preview\"]').currentTime > 0.5");
  await page.evaluate(() => document.querySelector('video[aria-label="Reel preview"]').pause());
  await noOverflow("reel-preview");
  await click("Export");
  await wait("window.__downloads.length === 2");
  const reelDownload = await page.evaluate("window.__downloads[1]");
  assert.equal(reelDownload.name, "reel.mp4");
  const reelBytes = Buffer.from(reelDownload.base64, "base64");
  const previewedReel = await page.evaluate(async () => { const b = new Uint8Array(await (await fetch(document.querySelector('video[aria-label="Reel preview"]').src)).arrayBuffer()); let s = ""; b.forEach((x) => (s += String.fromCharCode(x))); return btoa(s); });
  assert.deepEqual(reelBytes, Buffer.from(previewedReel, "base64"), "exported MP4 differs from the previewed MP4");
  writeFileSync(path.join(output, "reel-ui.mp4"), reelBytes);

  assert.equal(await page.evaluate('window.__aiCalls.length'), aiCallsBeforeManual, 'manual render reads no AI jobs');
  assert.equal(await page.evaluate('window.__inserted.length'), insertsBeforeManual, 'manual render creates no job');

  // Completed assisted plans enter the same production UI and real renderer endpoints.
  const fixtureJob = '11111111-1111-4111-8111-111111111111';
  for (const format of ['carousel', 'reel']) {
    await page.goto({ url: address + '/?job=' + fixtureJob + '&format=' + format, timeout: 30000 });
    await wait("document.body.innerText.includes('Make it from my photos')");
    const planWords = await page.evaluate('document.body.innerText');
    for (const word of ['CreateNow', 'Fast Mode', 'Creative Package', 'Creative Job', 'Asset Job', 'Satori', 'Remotion', 'Worker']) assert.equal(planWords.toLowerCase().includes(word.toLowerCase()), false, word);
    await click('Make it from my photos');
    await wait("document.querySelector('section[aria-label=\"Create content\"] select')?.value === 'fm-product'");
    assert.equal(await page.evaluate("[...document.querySelectorAll('button[aria-pressed=true]')].map(b => b.textContent.trim()).join('')"), format === 'carousel' ? 'Carousel' : 'Reel');
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('input')].map(i => i.type === 'checkbox' ? i.checked : i.value)"), [false, '', '', '', false]);
    await wait("document.querySelectorAll('button[aria-pressed]').length === 8");
    for (const id of [1, 2, 3, 4, 5]) await pickPattern(id);
    await setField('input[type=number]', '160');
    await setField("input[placeholder='2 pcs']", '2 pcs');
    await setField("input[placeholder='Message us to order']", 'Message us to order');
    await page.evaluate(() => document.querySelector('input[name=offer-confirmed]').click());
    await page.evaluate(() => document.querySelector('input[name=media-attested]').click());
    await wait("document.querySelector('[role=alert]')?.innerText.includes('instagram caption: ₱180.00')");
    await wait("!" + `[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Generate").disabled`);
    await noOverflow('assisted-' + format);
    await click('Generate');
    await wait("!!document.querySelector('section[aria-label=\"Preview\"]')", 2400);
    assert.match(await page.evaluate("document.querySelector('[role=alert]').innerText"), /Caption: ₱170.00/);
    assert.match(await page.evaluate("document.querySelector('[role=alert]').innerText"), /instagram caption: ₱180.00/);
    await click('Export');
    await wait('window.__downloads.length === 1');
    await click('Back');
    await click('Back to content plan');
    await wait("document.body.innerText.includes('Make it from my photos')");
    await click('Copy caption');
    await wait("window.__copied === 'Order a box for ₱170.'");
  }

  for (const format of ['photo', 'story']) {
    await page.goto({ url: address + '/?job=' + fixtureJob + '&format=' + format, timeout: 30000 });
    await wait("document.body.innerText.includes('Creative details')");
    assert.equal(await page.evaluate("document.body.innerText.includes('Make it from my photos')"), false);
  }
  await page.goto({ url: address + '/?job=' + fixtureJob + '&noProduct=1', timeout: 30000 });
  await wait("document.body.innerText.includes('Make it from my photos')");
  await click('Make it from my photos');
  await wait("!!document.querySelector('section[aria-label=\"Create content\"] select')");
  assert.equal(await page.evaluate("document.querySelector('select').value"), '');
  // Prefills are changeable, and a product with fewer than five items gets a clear explanation.
  await page.evaluate(() => { const s = document.querySelector('select'); s.value = 'other-product'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait("document.body.innerText.includes('This product has 1.')");
  assert.equal(await buttonDisabled('Generate'), true);

  // Successful assisted submission still uses the original job contract, then reaches the package.
  await page.goto({ url: address, timeout: 30000 });
  await wait("!!document.querySelector('textarea')");
  await setField('textarea', 'Show our bars');
  await page.evaluate(() => { const s = document.querySelector('select'); s.value = 'fm-product'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('Create content');
  await wait("document.body.innerText.includes('Make it from my photos')");
  const inserted = await page.evaluate('window.__inserted');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].table, 'creative_jobs');
  assert.equal(inserted[0].row.intent.text, 'Show our bars');
  assert.equal(inserted[0].row.intent.productId, 'fm-product');
  assert.equal(inserted[0].row.worker_type, 'creative_ai');

  // The server, not the checkbox, is the gate: a crafted request without the attestation is refused.
  const crafted = await fetch(`${address}/api/content-studio/carousel`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner-test-token" },
    body: JSON.stringify({ format: "carousel", productId: "fm-product", mediaIds: ["p1", "p2", "p3", "p4", "p5"], offer: { priceAmount: 160, unit: "2 pcs", cta: "Message us", confirmed: true }, mediaAttested: false, slide: 1 }),
  });
  assert.equal(crafted.status, 400);

  // Unauthenticated calls never reach the service.
  assert.equal((await fetch(`${address}/api/content-studio/carousel`, { method: "POST", body: "{}" })).status, 401);

  const evidence = {
    status: "PASS",
    assistedHandoff: ["carousel", "reel"], manualWhenPlanningUnavailable: true, manualWithoutAIJob: true,
    priceWarningBeforeGenerationAndExport: true, copyUnchanged: true, unsupportedFormatsHidden: ["photo", "story"],
    missingProductUnselected: true, fiveMediaExplanation: true, assistedSubmissionIntact: true,
    productSelection: true, formatSelection: true, mediaLibrarySelection: true, otherProductMediaHidden: true,
    offerConfirmationGate: true, mediaAttestationGate: true, attestationResetsOnMediaChange: true, craftedUnattestedRequestRefused: true, serverErrorState: true,
    carousel: { slides: 5, size: "1080x1350", zipMatchesPreview: true, regenerate: true, back: true },
    reel: { previewDurationSeconds: duration, playable: true, exportMatchesPreview: true, bytes: reelBytes.length },
    noTechnicalVocabulary: true, widths: [320, 375, 390, 1280],
    adapters: "owner-scoped Supabase client is a local fixture; service, renderers, gates are real; media are synthetic patterns",
  };
  writeFileSync(path.join(output, "ui-result.json"), JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify(evidence) + "\n");
} finally {
  if (browser) await browser.close({ silent: true });
  await new Promise((resolve) => server.close(resolve));
}
