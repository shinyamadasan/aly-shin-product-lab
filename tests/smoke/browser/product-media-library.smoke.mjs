// Opt-in browser acceptance of the real component/upload code. Storage and row persistence use
// a LOCAL fixture adapter (not Supabase). The real SQL/RLS gate is the separate postgres smoke.
// No dependency additions: esbuild, postcss, Tailwind and Remotion's test browser are already locked.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { openBrowser } from "@remotion/renderer";
import { screenshot } from "../../../node_modules/@remotion/renderer/dist/puppeteer-screenshot.js";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, "outputs/media-acceptance");
mkdirSync(output, { recursive: true });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProductMediaLibrary } from './src/components/product-media-library';
const rows = () => JSON.parse(localStorage.getItem('media-fixture-rows') || '[]');
const save = (value) => localStorage.setItem('media-fixture-rows', JSON.stringify(value));
const client = {
  from() { return {
    select() { let result = rows(); const q = {
      eq(c,v) { result = result.filter(r => r[c] === v); return q; },
      is(c,v) { result = result.filter(r => r[c] === v); return q; },
      order() { return q; }, then(resolve) { resolve({data:result,error:null}); }
    }; return q; },
    insert(row) { return {select:() => ({single:async () => { const item = {...row,created_at:new Date().toISOString()}; save([...rows(),item]); return {data:item,error:null}; }})}; },
    update(patch) { return {eq:(_c,id) => ({select:() => ({maybeSingle:async () => {const all=rows();const item=all.find(r=>r.id===id);Object.assign(item,patch);save(all);return {data:item,error:null};}})})}; }
  }; },
  storage: { from() { return {
    async upload(path,bytes,options) { const response=await fetch('/upload?path='+encodeURIComponent(path),{method:'POST',headers:{'content-type':options.contentType},body:bytes});return {data:{},error:response.ok?null:{message:'failed'}}; },
    async createSignedUrl(path,seconds) { const response=await fetch('/sign?path='+encodeURIComponent(path)+'&seconds='+seconds);return {data:await response.json(),error:null}; }
  }; } }
};
createRoot(document.getElementById('root')).render(<ProductMediaLibrary client={client} products={[{id:'media-test-product',name:'Media Test Product'},{id:'other-product',name:'Other Test Product'}]} />);
`;
await build({ stdin: { contents: entry, resolveDir: root, loader: "jsx" }, outfile: path.join(output, "app.js"), bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": "undefined", "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": "undefined" } });
const css = await postcss([tailwind({ base: root })]).process(readFileSync(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
writeFileSync(path.join(output, "app.css"), css.css);
const objects = new Map();
const signatures = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://local.test");
  if (url.pathname === "/upload" && request.method === "POST") {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    objects.set(url.searchParams.get("path"), { bytes: Buffer.concat(chunks), mime: request.headers["content-type"] });
    response.end("ok"); return;
  }
  if (url.pathname === "/sign") {
    const token = randomUUID(); signatures.set(token, { path: url.searchParams.get("path"), expires: Date.now() + 300000 });
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ signedUrl: `/preview?token=${token}` })); return;
  }
  if (url.pathname === "/preview") {
    const signature = signatures.get(url.searchParams.get("token"));
    const object = signature && Date.now() < signature.expires ? objects.get(signature.path) : null;
    if (!object) { response.writeHead(403); response.end("Forbidden"); return; }
    response.setHeader("content-type", object.mime); response.end(object.bytes); return;
  }
  if (url.pathname === "/app.js" || url.pathname === "/app.css") {
    response.setHeader("content-type", url.pathname.endsWith("css") ? "text/css" : "application/javascript");
    response.end(readFileSync(path.join(output, url.pathname.slice(1)))); return;
  }
  if (url.pathname !== "/") { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><main style="max-width:1100px;margin:auto;padding:20px"><div id="root"></div></main><script src="/app.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await openBrowser("chrome", { browserExecutable: process.env.MEDIA_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe", chromiumOptions: { headless: true } });
  const page = await browser.newPage({ context: () => null, logLevel: "error", indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} });
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await page.evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${expression}`);
  };
  await page.goto({ url: address, timeout: 30000 });
  await wait("!!document.querySelector('input[type=file]')");
  await page.evaluate(() => { const select = document.querySelector("select"); select.value = "media-test-product"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const files = ["jpg", "png", "webp", "mp4"].map((ext) => ({ name: `test-pattern.${ext}`, base64: readFileSync(path.join(root, `tests/fixtures/product-media/test-pattern.${ext}`)).toString("base64") }));
  await page.evaluate((fixtures) => {
    const input = document.querySelector("input[type=file]"); const transfer = new DataTransfer();
    for (const fixture of fixtures) transfer.items.add(new File([Uint8Array.from(atob(fixture.base64), c => c.charCodeAt(0))], fixture.name));
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  }, files);
  await wait("document.querySelectorAll('article').length === 4 && !document.querySelector('select').disabled");
  await wait("[...document.querySelectorAll('img')].every(i => i.complete && i.naturalWidth === 160) && document.querySelector('video').readyState >= 2");
  assert.equal(await page.evaluate("document.querySelector('video').duration"), 1);
  await page.evaluate(() => document.querySelector("video").play());
  await wait("document.querySelector('video').currentTime > 0");
  await page.evaluate(() => document.querySelector("video").pause());
  await page.goto({ url: address, timeout: 30000 });
  await wait("document.querySelectorAll('article').length === 4");
  assert.equal(await page.evaluate("[...document.querySelectorAll('article select')].every(s => s.value === 'media-test-product')"), true);
  await page.evaluate(() => { const s = document.querySelector('[aria-label="Media filters"] select'); s.value = 'other-product'; s.dispatchEvent(new Event('change', {bubbles:true})); });
  await wait("document.querySelectorAll('article').length === 0");
  await page.evaluate(() => { const s = document.querySelector('[aria-label="Media filters"] select'); s.value = 'media-test-product'; s.dispatchEvent(new Event('change', {bubbles:true})); });
  await wait("document.querySelectorAll('article').length === 4");
  await page.evaluate(() => { const s = document.querySelector('article select'); s.value = ''; s.dispatchEvent(new Event('change', {bubbles:true})); });
  await wait("document.querySelectorAll('article').length === 3");
  await page.evaluate(() => { const s = document.querySelector('[aria-label="Media filters"] select'); s.value = 'unassigned'; s.dispatchEvent(new Event('change', {bubbles:true})); });
  await wait("document.querySelectorAll('article').length === 1");
  await page.evaluate(() => document.querySelector('article button').click());
  await wait("document.querySelector('article button').getAttribute('aria-pressed') === 'true'");
  await page.evaluate(() => document.querySelector('[aria-label="Media filters"] button').click());
  await wait("document.querySelectorAll('article').length === 4");
  for (const width of [320, 375, 390, 1280]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true, `overflow at ${width}`);
    assert.equal(await page.evaluate("[...document.querySelectorAll('select')].every(s => parseFloat(getComputedStyle(s).fontSize) >= 16)"), true);
    await screenshot({ page, type: "png", path: path.join(output, `media-${width}.png`), omitBackground: false, width, height: 1000, scale: 1 });
  }
  assert.equal((await fetch(`${address}/preview`)).status, 403);
  const evidence = { status: "PASS", photos: 3, h264Video: 1, productAssignment: true, reload: true, previewAndPlayback: true, filter: true, unassigned: true, select: true, widths: [320, 375, 390, 1280], storage: "local signed-preview fixture adapter; SQL/RLS separately verified" };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify(evidence) + "\n");
} finally {
  if (browser) await browser.close({ silent: true });
  await new Promise((resolve) => server.close(resolve));
}
