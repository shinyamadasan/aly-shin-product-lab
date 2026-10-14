import test from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

import type { PreparedCampaign } from "../src/lib/content-studio/creative-plan.ts";
import { readPngDimensions } from "../src/lib/content-studio/export-output.ts";
import { generateCarouselSlide, generateReel } from "../src/lib/content-studio/fast-mode-service.ts";
import type { FastModeSourceClient, SourceMediaRow } from "../src/lib/content-studio/fast-mode-sources.ts";
import { handleCarouselPost, handleReelGet, handleReelPost, type FastModeAuthenticate, type ReelHost } from "../src/lib/content-studio/fast-mode-routes.ts";
import { CONTENT_STUDIO_REEL_RENDERING_ENV, reelRenderingAvailable } from "../src/lib/content-studio/reel-host.ts";
import { authenticateOwnerWith } from "../src/lib/production-auth.ts";

// Content Studio Fast Mode -- the owner route logic end to end with a fake owner-scoped client:
// request -> trusted rows -> spec -> export gate -> render -> output gate. Images are synthetic
// test patterns; nothing here talks to Supabase.

const photo = sharp({ create: { width: 1200, height: 1500, channels: 3, background: "#7a4a2a" } }).jpeg().toBuffer();

function row(id: string, overrides: Partial<SourceMediaRow> = {}): SourceMediaRow {
  return { id, product_id: "revel-bars", media_type: "photo", duration_ms: null, storage_bucket: "product-media", storage_path: `${id}.jpg`, ...overrides };
}

function fakeClient(rows: SourceMediaRow[], options: { product?: { id: string; name: string } | null; downloads?: string[] } = {}) {
  const downloads = options.downloads ?? [];
  const product = options.product === undefined ? { id: "revel-bars", name: "Revel Bars" } : options.product;
  const client = {
    from(table: string) {
      if (table === "products") {
        return { select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: product && product.id === id ? product : null, error: null }) }) }) };
      }
      return { select: () => ({ in: async (_c: string, ids: string[]) => ({ data: rows.filter((r) => ids.includes(r.id)), error: null }) }) };
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloads.push(path);
          return { data: new Blob([new Uint8Array(await photo)]), error: null };
        },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null }),
      }),
    },
  };
  return client as unknown as FastModeSourceClient;
}

const IDS = ["m1", "m2", "m3", "m4", "m5"];
const body = (overrides: Record<string, unknown> = {}) => ({
  format: "carousel",
  productId: "revel-bars",
  mediaIds: IDS,
  offer: { priceAmount: 160, unit: "2 pcs", cta: "Message us to order", confirmed: true },
  mediaAttested: true,
  slide: 4,
  ...overrides,
});

test("an owner carousel slide comes back as a 1080x1350 PNG, reading only that slide's photo", async () => {
  const downloads: string[] = [];
  const result = await generateCarouselSlide(fakeClient(IDS.map((id) => row(id)), { downloads }), body());
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.equal(result.fileName, "carousel-04.png");
  assert.deepEqual(readPngDimensions(result.png), { width: 1080, height: 1350 });
  assert.deepEqual(downloads, ["m4.jpg"]);
});

test("carousel error states speak to the owner and never render", async () => {
  const rows = IDS.map((id) => row(id));
  const expect = async (client: FastModeSourceClient, payload: unknown, status: number, pattern: RegExp) => {
    const result = await generateCarouselSlide(client, payload);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, status);
      assert.match(result.message, pattern);
    }
  };
  await expect(fakeClient(rows), body({ slide: 9 }), 400, /could not be read/);
  await expect(fakeClient(rows), body({ format: "reel" }), 400, /could not be read/);
  await expect(fakeClient(rows, { product: null }), body(), 404, /product could not be found/);
  await expect(fakeClient(rows.map((r, i) => (i === 0 ? { ...r, product_id: "brownies" } : r))), body(), 400, /main photo is not assigned to Revel Bars/);
  // A row pointing at another bucket is never read from; it is treated as missing.
  await expect(fakeClient(rows.map((r, i) => (i === 4 ? { ...r, storage_bucket: "generated-assets" } : r))), body(), 404, /closing photo is no longer in Media/);
  await expect(fakeClient(rows.map((r, i) => (i === 1 ? { ...r, media_type: "video", duration_ms: 5000 } : r))), body(), 400, /five photos/);
  await expect(fakeClient(rows), body({ offer: { priceAmount: 160, unit: "2 pcs", cta: "Message us", confirmed: false } }), 400, /Confirm the price/);
  await expect(fakeClient(rows), body({ offer: { priceAmount: 160, unit: "W".repeat(24), cta: "Message us", confirmed: true } }), 422, /selling unit/);
  // The attestation is enforced by the server: a crafted request without it, or with false, never renders.
  await expect(fakeClient(rows), body({ mediaAttested: undefined }), 400, /could not be read/);
  await expect(fakeClient(rows), body({ mediaAttested: false }), 400, /real pictures of your own food/);
});

test("the Reel is refused plainly on a server that cannot make one", async () => {
  let rendered = false;
  const result = await generateReel(fakeClient(IDS.map((id) => row(id))), body({ format: "reel" }), {
    available: () => false,
    render: async () => {
      rendered = true;
      return { ok: false, reason: "failed", issues: [] };
    },
  });
  assert.deepEqual(result, { ok: false, status: 503, message: "Reels can only be made on the studio computer right now. You can make a carousel here." });
  assert.equal(rendered, false);
  assert.equal(reelRenderingAvailable({}), false);
  assert.equal(reelRenderingAvailable({ [CONTENT_STUDIO_REEL_RENDERING_ENV]: "0" }), false);
});

test("the Reel host receives one prepared owner campaign: real clip as a signed URL, photos as stills", async () => {
  const rows = IDS.map((id) => row(id));
  rows[2] = row("m3", { media_type: "video", duration_ms: 5000, storage_path: "m3.mp4" });
  let received: PreparedCampaign | null = null;
  const result = await generateReel(fakeClient(rows), body({ format: "reel" }), {
    available: () => true,
    render: async (campaign) => {
      received = campaign;
      return { ok: true, mp4: new Uint8Array([1, 2, 3]) };
    },
  });
  assert.ok(result.ok);
  const campaign = received as unknown as PreparedCampaign;
  assert.equal(campaign.notForPublishing, false);
  assert.ok(campaign.spec.media.every((m) => m.provenance === "owner_media"));
  assert.deepEqual(campaign.media.m3, { id: "m3", kind: "video", src: "https://storage.test/m3.mp4?token=t", durationSeconds: 5 });
  assert.equal(campaign.media.m1.kind, "photo");
  assert.equal(campaign.spec.offer.cta, "Message us to order");

  const busy = await generateReel(fakeClient(rows), body({ format: "reel" }), { available: () => true, render: async () => ({ ok: false, reason: "busy", issues: [] }) });
  assert.equal(busy.ok ? 0 : busy.status, 409);
  const invalid = await generateReel(fakeClient(rows), body({ format: "reel" }), { available: () => true, render: async () => ({ ok: false, reason: "invalid-output", issues: ["blank frames: 90."] }) });
  assert.equal(invalid.ok ? 0 : invalid.status, 502);

  const shortClip = rows.map((r) => (r.id === "m3" ? { ...r, duration_ms: 1000 } : r));
  const short = await generateReel(fakeClient(shortClip), body({ format: "reel" }), { available: () => true, render: async () => ({ ok: true, mp4: new Uint8Array() }) });
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.message, /in hand or in use clip is 1.0s; that part of the Reel needs 3.5s/);
});

// --- route-level: the HTTP boundary both routes put in front of the service --------------------------
//
// The real authenticateOwnerWith rule over a fake auth server: "owner-token" is the owner,
// "staff-token" is a signed-in account without the owner claim, anything else is rejected.
function routeAuth(client: FastModeSourceClient): FastModeAuthenticate {
  return (request) =>
    authenticateOwnerWith(request, {
      createClient: () => client,
      getUser: async (_client, token) =>
        token === "owner-token" ? { id: "u-owner", email: null, appMetadata: { app_role: "owner" } }
        : token === "staff-token" ? { id: "u-staff", email: null, appMetadata: { app_role: "staff" } }
        : null,
    });
}

const request = (method: "GET" | "POST", token: string | null, payload?: unknown) =>
  new Request("http://local.test/api/content-studio/x", {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

const unavailableHost: ReelHost = { available: () => false, render: async () => assert.fail("the Reel host must not be reached") };

test("routes: unauthenticated -> 401, signed-in non-owner -> 403, unconfigured -> 503, and the service is never reached", async () => {
  const downloads: string[] = [];
  const auth = routeAuth(fakeClient(IDS.map((id) => row(id)), { downloads }));
  const notConfigured: FastModeAuthenticate = async () => ({ ok: false, reason: "not-configured" });

  for (const [token, status] of [[null, 401], ["forged-token", 401], ["staff-token", 403]] as const) {
    assert.equal((await handleCarouselPost(request("POST", token, body()), auth)).status, status, `carousel ${token}`);
    assert.equal((await handleReelGet(request("GET", token), auth, unavailableHost)).status, status, `reel GET ${token}`);
    assert.equal((await handleReelPost(request("POST", token, body({ format: "reel" })), auth, unavailableHost)).status, status, `reel POST ${token}`);
  }
  assert.equal((await handleCarouselPost(request("POST", "owner-token", body()), notConfigured)).status, 503);
  assert.equal((await handleReelPost(request("POST", "owner-token", body({ format: "reel" })), notConfigured, unavailableHost)).status, 503);
  assert.deepEqual(downloads, [], "no media was read for a refused caller");
});

test("routes: an owner reaches normal request validation, and a Reel is 503 where hosted rendering is unavailable", async () => {
  const auth = routeAuth(fakeClient(IDS.map((id) => row(id))));

  const slide = await handleCarouselPost(request("POST", "owner-token", body()), auth);
  assert.equal(slide.status, 200);
  assert.equal(slide.headers.get("content-type"), "image/png");
  assert.deepEqual(readPngDimensions(new Uint8Array(await slide.arrayBuffer())), { width: 1080, height: 1350 });

  const unattested = await handleCarouselPost(request("POST", "owner-token", body({ mediaAttested: false })), auth);
  assert.equal(unattested.status, 400);
  assert.match(((await unattested.json()) as { message: string }).message, /real pictures of your own food/);
  const malformed = await handleCarouselPost(new Request("http://local.test/x", { method: "POST", headers: { authorization: "Bearer owner-token" }, body: "{" }), auth);
  assert.equal(malformed.status, 400);

  const get = await handleReelGet(request("GET", "owner-token"), auth, unavailableHost);
  assert.deepEqual(await get.json(), { available: false });
  const reel = await handleReelPost(request("POST", "owner-token", body({ format: "reel" })), auth, unavailableHost);
  assert.equal(reel.status, 503);
  assert.match(((await reel.json()) as { message: string }).message, /studio computer/);
});
