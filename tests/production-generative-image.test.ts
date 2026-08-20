import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  ALLOWED_GENERATIVE_IMAGE_REFERENCE_MIME_TYPES,
  DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL,
  GENERATIVE_IMAGE_PROVIDER,
  MAX_GENERATIVE_IMAGE_REFERENCES,
  MAX_GENERATIVE_IMAGE_REFERENCE_BYTES,
  MAX_GENERATIVE_IMAGE_RETRY_DELAY_MS,
  MAX_GENERATIVE_IMAGE_TRANSPORT_ATTEMPTS,
  PRODUCTION_EXECUTOR_TIMEOUTS_MS,
  TRANSIENT_GENERATIVE_IMAGE_HTTP_STATUSES,
  buildCloudflareGenerativeImageExecutor,
  buildGenerativeImagePrompt,
  buildStaticRendererExecutor,
  cloudflareGenerativeImageConfigFromEnv,
  loadGenerativeImageReferences,
  parseGenerativeImageReferencePaths,
  parseRetryAfterMs,
  readCloudflareImageBytes,
  resolveCloudflareModel,
  type GenerativeImageProvenance,
} from "../src/lib/production-asset-executors.ts";
import { PRODUCTION_IMAGE_DIMENSIONS, type ProductionSpecV1 } from "../src/lib/production-spec.ts";
import type { AssetGenerationSpecV1 } from "../src/lib/asset-generation-spec.ts";
import type { AssetJobRecord } from "../src/lib/asset-jobs.ts";

function spec(): ProductionSpecV1 {
  return {
    schemaVersion: "production-v1",
    assetKind: "image",
    sourceCreativePackageId: "package-1",
    dimensions: PRODUCTION_IMAGE_DIMENSIONS,
    copy: {
      headline: "little reward",
      caption: "A gentle dessert sharing moment.",
      cta: "save for the next craving",
      overlayText: "little reward",
    },
    brandStyle: null,
    visualBrief: {
      concept: "Two simple human figures sharing clean square brownie slices at a table.",
      style: "Warm hand-drawn editorial bakery illustration on a cream background.",
      scene: ["One person offers a neat brownie slice", "Two clean separated slices sit on a plate"],
      executionNotes: ["No body-horror food texture", "No readable text in generated image"],
    },
  };
}

function job(): AssetJobRecord {
  return {
    id: "job-1",
    creativePackageId: "package-1",
    status: "queued",
    workerType: "generative_image",
    assetKind: "image",
    attemptCount: 0,
    result: {},
    lastError: "",
    createdAt: "",
    updatedAt: "",
    startedAt: "",
    completedAt: "",
    failedAt: "",
  };
}

async function pngBytes(size = 1): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background: "#f8dfba" } }).png().toBuffer());
}

async function jpegBytes(size = 8): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background: "#b77442" } }).jpeg().toBuffer());
}

async function webpBytes(size = 8): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background: "#2a1812" } }).webp().toBuffer());
}

function imageResponse(bytes: Uint8Array<ArrayBuffer>, status = 200): Response {
  return new Response(bytes, { status, headers: { "content-type": "image/png" } });
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

// --- prompt (unchanged creative contract) ------------------------------------------------------------

test("generative image prompt keeps image generation text-free, stylized, and bakery-safe", () => {
  const prompt = buildGenerativeImagePrompt(spec());

  assert.match(prompt, /text-free/i);
  assert.match(prompt, /Do not generate readable text/i);
  assert.match(prompt, /visibly illustrated/i);
  assert.match(prompt, /ordinary bakery food/i);
  assert.match(prompt, /Avoid flesh-like texture/i);
});

test("Cloudflare generative_image executor uses direct fetch and returns a composed PNG candidate", async () => {
  const png = await pngBytes();
  let calledUrl = "";
  let auth = "";
  let prompt = "";

  const fetchImpl: typeof fetch = async (input, init) => {
    calledUrl = String(input);
    auth = String((init?.headers as Record<string, string>).Authorization);
    prompt = String((init?.body as FormData).get("prompt"));
    return imageResponse(png);
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "account-id", apiToken: "token-value", fetchImpl });
  const result = await executor(job(), spec(), { signal: new AbortController().signal });

  assert.match(calledUrl, /\/accounts\/account-id\/ai\/run\//);
  assert.equal(auth, "Bearer token-value");
  assert.match(prompt, /Do not generate readable text/);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.mimeType, "image/png");
  assert.equal(result[0]?.width, 1080);
  assert.equal(result[0]?.height, 1080);
});

// --- P: contract enforcement -------------------------------------------------------------------------

test("the production-only executors reject a legacy AssetGenerationSpecV1 rather than rendering it", async () => {
  const legacySpec = {
    schemaVersion: "v1",
    assetKind: "image",
    sourceCreativePackageId: "package-1",
    dimensions: { width: 1080, height: 1080, aspectRatio: "1:1" },
    headline: "Brownies",
    caption: "Ready.",
    visualDirection: "Overhead",
    brandStyle: null,
  } as unknown as AssetGenerationSpecV1;

  const generative = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl: async () => imageResponse(await pngBytes()) });
  await assert.rejects(() => Promise.resolve(generative(job(), legacySpec, { signal: new AbortController().signal })), /production-v1 image spec/);

  const staticRenderer = buildStaticRendererExecutor();
  await assert.rejects(() => Promise.resolve(staticRenderer(job(), legacySpec, { signal: new AbortController().signal })), /production-v1 image spec/);
});

// --- F/G/H/Q: provider response handling -------------------------------------------------------------

test("F: a non-transient non-2xx response fails with the status and a bounded detail, and is never retried", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("bad request detail", { status: 400 });
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), { signal: new AbortController().signal })), /failed with 400/);
  assert.equal(calls, 1, "a 400 is the provider rejecting the request itself -- retrying it is pointless");
});

test("G: a structured base64 JSON response is decoded into real image bytes", async () => {
  const png = await pngBytes();
  const fetchImpl: typeof fetch = async () => jsonResponse({ result: { image: Buffer.from(png).toString("base64") } });

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  const result = await executor(job(), spec(), { signal: new AbortController().signal });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.mimeType, "image/png");
});

test("H: a 200 response carrying only provider errors[] surfaces those messages, not a generic failure", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ errors: [{ message: "model overloaded" }, { message: "try later" }] });

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), { signal: new AbortController().signal })), /model overloaded; try later/);
});

test("H: a 200 JSON response with neither image nor errors still fails clearly", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ result: {} });

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), { signal: new AbortController().signal })), /did not include image bytes/);
});

test("Q: the media type comes from decoded MAGIC BYTES, never from the content-type header", async () => {
  // A provider that mislabels JPEG bytes as image/png must not make us record image/png.
  const jpeg = await jpegBytes();
  const mislabelled = new Response(jpeg, { status: 200, headers: { "content-type": "image/png" } });
  assert.equal((await readCloudflareImageBytes(mislabelled)).mimeType, "image/jpeg");

  const webp = new Response(await webpBytes(), { status: 200, headers: { "content-type": "application/octet-stream" } });
  assert.equal((await readCloudflareImageBytes(webp)).mimeType, "image/webp");

  const png = new Response(await pngBytes(), { status: 200, headers: { "content-type": "image/png" } });
  assert.equal((await readCloudflareImageBytes(png)).mimeType, "image/png");
});

test("Q: undecodable bytes fail as undecodable instead of being defaulted to image/png", async () => {
  const garbage = new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200, headers: { "content-type": "image/png" } });
  await assert.rejects(() => readCloudflareImageBytes(garbage), /not a supported image/);
});

// --- J: bounded transient retry ----------------------------------------------------------------------

test("J: a transient status is retried exactly once, and the retry can succeed", async () => {
  for (const status of TRANSIENT_GENERATIVE_IMAGE_HTTP_STATUSES) {
    const png = await pngBytes();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status, headers: { "retry-after": "0" } }) : imageResponse(png);
    };

    const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
    const result = await executor(job(), spec(), { signal: new AbortController().signal });

    assert.equal(result.length, 1, `status ${status} should have been retried into a success`);
    assert.equal(calls, 2, `status ${status} should cost exactly two transport attempts`);
  }
});

test("J: retries are BOUNDED -- a persistently transient provider is never hammered", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("still busy", { status: 503, headers: { "retry-after": "0" } });
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), { signal: new AbortController().signal })), /failed with 503/);
  assert.equal(calls, MAX_GENERATIVE_IMAGE_TRANSPORT_ATTEMPTS);
  assert.equal(calls, 2, "one initial request plus at most one retry -- never a storm");
});

test("J: each transport attempt gets a FRESH body -- a consumed FormData cannot be re-sent", async () => {
  const png = await pngBytes();
  const seenPrompts: string[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    const form = init?.body as FormData;
    seenPrompts.push(String(form.get("prompt")));
    return calls === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "0" } }) : imageResponse(png);
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await executor(job(), spec(), { signal: new AbortController().signal });

  assert.equal(seenPrompts.length, 2);
  assert.equal(seenPrompts[0], seenPrompts[1], "the retry must send the same prompt, from a rebuilt body");
});

test("J: Retry-After is parsed, honoured, and CLAMPED so a provider cannot outlast the executor timeout", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs("0"), 500, "a non-positive delay falls back to the small fixed backoff");
  assert.equal(parseRetryAfterMs(null), 500);
  assert.equal(parseRetryAfterMs("not-a-delay"), 500);
  // An HTTP-date form.
  assert.equal(parseRetryAfterMs(new Date(1_000_000 + 3000).toUTCString(), 1_000_000), 3000);
  // The clamp: a fifteen minute ask is capped, never honoured literally.
  assert.equal(parseRetryAfterMs("900"), MAX_GENERATIVE_IMAGE_RETRY_DELAY_MS);
  assert.ok(MAX_GENERATIVE_IMAGE_RETRY_DELAY_MS < PRODUCTION_EXECUTOR_TIMEOUTS_MS.generative_image);
});

// --- I: timeout / abort ------------------------------------------------------------------------------

test("I: the runner's abort signal is threaded into the provider request", async () => {
  let sawSignal: AbortSignal | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    sawSignal = init?.signal ?? null;
    return imageResponse(await pngBytes());
  };

  const controller = new AbortController();
  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await executor(job(), spec(), { signal: controller.signal });

  assert.equal(sawSignal, controller.signal);
});

test("I: an abort DURING the retry backoff rejects immediately instead of sleeping it out", async () => {
  const controller = new AbortController();
  const fetchImpl: typeof fetch = async () => new Response("busy", { status: 503, headers: { "retry-after": "9" } });

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  const started = Date.now();
  const pending = executor(job(), spec(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(() => Promise.resolve(pending), /aborted/);
  assert.ok(Date.now() - started < 2000, "aborting must not wait out the full backoff");
});

test("I: a provider that rejects on abort surfaces that rejection", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("The operation was aborted.");
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), { signal: new AbortController().signal })), /aborted/);
});

test("I: generative_image has its OWN explicit timeout, larger than the legacy 30s executor default", () => {
  assert.equal(PRODUCTION_EXECUTOR_TIMEOUTS_MS.generative_image, 120_000);
  assert.ok(PRODUCTION_EXECUTOR_TIMEOUTS_MS.generative_image > 30_000, "inheriting the mock/external default reported provider latency as a timeout");
  assert.equal(PRODUCTION_EXECUTOR_TIMEOUTS_MS.static_renderer, 30_000);
  // Finite, always: an unbounded wait leaves a permanently running job with no recovery path.
  for (const value of Object.values(PRODUCTION_EXECUTOR_TIMEOUTS_MS)) {
    assert.ok(Number.isFinite(value) && value > 0);
  }
});

// --- K/L/M: configuration ----------------------------------------------------------------------------

test("K: missing Cloudflare credentials fail loudly at config time, naming both variables", () => {
  assert.throws(() => cloudflareGenerativeImageConfigFromEnv({}), /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
  assert.throws(() => cloudflareGenerativeImageConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a" }), /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
  assert.throws(() => cloudflareGenerativeImageConfigFromEnv({ CLOUDFLARE_API_TOKEN: "t" }), /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
});

test("L: the model is configurable, defaults when unset, and reaches the endpoint URL", async () => {
  const fromDefault = cloudflareGenerativeImageConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" });
  assert.equal(fromDefault.model, DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL);

  const overridden = cloudflareGenerativeImageConfigFromEnv({
    CLOUDFLARE_ACCOUNT_ID: "a",
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_GENERATIVE_IMAGE_MODEL: "@cf/some/other-model",
  });
  assert.equal(overridden.model, "@cf/some/other-model");

  let calledUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    calledUrl = String(input);
    return imageResponse(await pngBytes());
  };
  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", model: "@cf/some/other-model", fetchImpl });
  await executor(job(), spec(), { signal: new AbortController().signal });
  assert.match(decodeURIComponent(calledUrl), /@cf\/some\/other-model$/);
});

test("M: reference paths parse on semicolons, trim, and drop empties", () => {
  assert.deepEqual(parseGenerativeImageReferencePaths(undefined), []);
  assert.deepEqual(parseGenerativeImageReferencePaths(""), []);
  assert.deepEqual(parseGenerativeImageReferencePaths("  "), []);
  assert.deepEqual(parseGenerativeImageReferencePaths("C:\\a\\one.png; C:\\b\\two.jpg ;"), ["C:\\a\\one.png", "C:\\b\\two.jpg"]);
  // Semicolon, not comma -- a path may legitimately contain a comma.
  assert.deepEqual(parseGenerativeImageReferencePaths("C:\\a, b\\one.png"), ["C:\\a, b\\one.png"]);
});

// --- N/O: reference image safety and provenance ------------------------------------------------------

async function writeReference(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

test("N: approved references are attached to the provider request as indexed form fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ref-attach-"));
  const first = await writeReference(dir, "one.png", await pngBytes(8));
  const second = await writeReference(dir, "two.jpg", await jpegBytes());

  let form: FormData | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    form = init?.body as FormData;
    return imageResponse(await pngBytes());
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl, referenceImagePaths: [first, second] });
  await executor(job(), spec(), { signal: new AbortController().signal });

  assert.notEqual(form, null);
  const attached = form as unknown as FormData;
  const zero = attached.get("input_image_0");
  const one = attached.get("input_image_1");
  assert.ok(zero instanceof Blob);
  assert.ok(one instanceof Blob);
  assert.equal((zero as File).name, "one.png");
  assert.equal((one as File).name, "two.jpg");
  assert.equal(attached.get("input_image_2"), null);
});

test("O: too many references are refused before any provider request is made", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ref-count-"));
  const paths: string[] = [];
  for (let index = 0; index <= MAX_GENERATIVE_IMAGE_REFERENCES; index += 1) {
    paths.push(await writeReference(dir, `ref-${index}.png`, await pngBytes(8)));
  }

  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return imageResponse(await pngBytes());
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl, referenceImagePaths: paths });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), { signal: new AbortController().signal })), /At most 4 generative image references/);
  assert.equal(calls, 0, "an invalid reference set must never cost a provider request");
});

test("O: an oversized reference is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ref-size-"));
  // A real, decodable PNG that is deliberately larger than the per-reference ceiling.
  const big = new Uint8Array(await sharp({ create: { width: 2400, height: 2400, channels: 3, background: "#ffffff" } })
    .png({ compressionLevel: 0 })
    .toBuffer());
  assert.ok(big.length > MAX_GENERATIVE_IMAGE_REFERENCE_BYTES, "fixture must actually exceed the limit");
  const filePath = await writeReference(dir, "big.png", big);

  await assert.rejects(() => loadGenerativeImageReferences([filePath]), /over the \d+ byte limit/);
});

test("O: an unreadable reference path fails clearly instead of being silently skipped", async () => {
  const missing = path.join(tmpdir(), "definitely-not-here", "nope.png");
  await assert.rejects(() => loadGenerativeImageReferences([missing]), /could not be read: nope\.png/);
});

test("O: a file that is not a supported image is refused, whatever its extension claims", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ref-type-"));
  const notAnImage = await writeReference(dir, "trojan.png", new TextEncoder().encode("this is plainly not a PNG"));
  await assert.rejects(() => loadGenerativeImageReferences([notAnImage]), /not a supported image/);

  const empty = await writeReference(dir, "empty.png", new Uint8Array(0));
  await assert.rejects(() => loadGenerativeImageReferences([empty]), /is empty/);
});

test("O: every allowed reference type decodes, and each yields real identity facts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ref-ok-"));
  const paths = [
    await writeReference(dir, "a.png", await pngBytes(16)),
    await writeReference(dir, "b.jpg", await jpegBytes(16)),
    await writeReference(dir, "c.webp", await webpBytes(16)),
  ];

  const loaded = await loadGenerativeImageReferences(paths);
  assert.equal(loaded.length, 3);
  assert.deepEqual(loaded.map((reference) => reference.mimeType), [...ALLOWED_GENERATIVE_IMAGE_REFERENCE_MIME_TYPES]);
  for (const reference of loaded) {
    assert.equal(reference.width, 16);
    assert.equal(reference.height, 16);
    assert.ok(reference.byteSize > 0);
    assert.match(reference.sha256, /^[0-9a-f]{64}$/);
  }
});

// --- D: provider / model / attempt / reference provenance --------------------------------------------

test("D: a successful generation reports which provider, which model, which attempt, and which references", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ref-prov-"));
  const reference = await writeReference(dir, "anchor.png", await pngBytes(16));

  const png = await pngBytes();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    // Force exactly one transient retry so transportAttempts is proven to be OBSERVED, not assumed.
    return calls === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "0" } }) : imageResponse(png);
  };

  let provenance: GenerativeImageProvenance | null = null;
  const executor = buildCloudflareGenerativeImageExecutor({
    accountId: "account-id",
    apiToken: "t",
    model: "@cf/some/other-model",
    fetchImpl,
    referenceImagePaths: [reference],
    onProvenance: (captured) => {
      provenance = captured;
    },
  });
  await executor(job(), spec(), { signal: new AbortController().signal });

  assert.notEqual(provenance, null);
  const captured = provenance as unknown as GenerativeImageProvenance;
  assert.equal(captured.provider, GENERATIVE_IMAGE_PROVIDER);
  assert.equal(captured.provider, "cloudflare-workers-ai");
  assert.equal(captured.model, "@cf/some/other-model");
  assert.equal(captured.transportAttempts, 2);
  assert.match(captured.endpoint, /\/accounts\/account-id\/ai\/run\//);
  assert.match(captured.promptSha256, /^[0-9a-f]{64}$/);

  assert.equal(captured.references.length, 1);
  assert.equal(captured.references[0].fileName, "anchor.png");
  assert.equal(captured.references[0].mimeType, "image/png");
  assert.match(captured.references[0].sha256, /^[0-9a-f]{64}$/);

  // The PROMPT ITSELF is never carried in provenance -- only its digest. asset_job_attempts is
  // documented as bounded, redacted diagnostics: never prompts, raw requests, or credentials.
  const serialized = JSON.stringify(captured);
  assert.doesNotMatch(serialized, /Do not generate readable text/);
  assert.doesNotMatch(serialized, /token/i);
  assert.equal("bytes" in captured.references[0], false, "reference BYTES must not travel into provenance");
});

test("D: the reported model is the default when nothing overrides it", async () => {
  let provenance: GenerativeImageProvenance | null = null;
  const fetchImpl: typeof fetch = async () => imageResponse(await pngBytes());
  const executor = buildCloudflareGenerativeImageExecutor({
    accountId: "a",
    apiToken: "t",
    fetchImpl,
    onProvenance: (captured) => {
      provenance = captured;
    },
  });
  await executor(job(), spec(), { signal: new AbortController().signal });

  assert.equal((provenance as unknown as GenerativeImageProvenance).model, DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL);
  assert.equal((provenance as unknown as GenerativeImageProvenance).transportAttempts, 1);
});

// --- durable provenance handoff to the runner --------------------------------------------------------
//
// The executor reports provider/model through the runner's context so it can be persisted on
// asset_job_attempts. WHEN it reports is the whole contract: after references are validated (so a
// refused reference set never claims a provider) and before the request is sent (so a failure still
// records what was contacted).

function provenanceRecorder() {
  const recorded: Array<{ provider: string; model: string }> = [];
  return {
    recorded,
    context: (signal: AbortSignal) => ({ signal, recordProvenance: (p: { provider: string; model: string }) => void recorded.push(p) }),
  };
}

test("the executor reports provider/model to the runner on success", async () => {
  const recorder = provenanceRecorder();
  const fetchImpl: typeof fetch = async () => imageResponse(await pngBytes());

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await executor(job(), spec(), recorder.context(new AbortController().signal));

  assert.deepEqual(recorder.recorded, [{ provider: "cloudflare-workers-ai", model: DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL }]);
});

test("the reported model is the OVERRIDE actually used, not the default", async () => {
  const recorder = provenanceRecorder();
  const fetchImpl: typeof fetch = async () => imageResponse(await pngBytes());

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", model: "@cf/some/other-model", fetchImpl });
  await executor(job(), spec(), recorder.context(new AbortController().signal));

  assert.deepEqual(recorder.recorded, [{ provider: "cloudflare-workers-ai", model: "@cf/some/other-model" }]);
});

test("provenance is reported BEFORE the request, so a provider failure still records what was contacted", async () => {
  const recorder = provenanceRecorder();
  const fetchImpl: typeof fetch = async () => new Response("upstream exploded", { status: 500 });

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", model: "@cf/some/other-model", fetchImpl });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), recorder.context(new AbortController().signal))), /failed with 500/);

  assert.deepEqual(recorder.recorded, [{ provider: "cloudflare-workers-ai", model: "@cf/some/other-model" }]);
});

test("a bounded transient retry still reports the provider exactly once", async () => {
  const recorder = provenanceRecorder();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "0" } }) : imageResponse(await pngBytes());
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl });
  await executor(job(), spec(), recorder.context(new AbortController().signal));

  assert.equal(calls, 2);
  assert.equal(recorder.recorded.length, 1, "one attempt row means one provenance report, however many transport tries it took");
});

test("a reference set the executor REFUSES never claims a provider was contacted", async () => {
  const recorder = provenanceRecorder();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return imageResponse(await pngBytes());
  };

  const missing = path.join(tmpdir(), "definitely-not-here", "nope.png");
  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl, referenceImagePaths: [missing] });
  await assert.rejects(() => Promise.resolve(executor(job(), spec(), recorder.context(new AbortController().signal))), /could not be read/);

  assert.equal(calls, 0, "no request was made");
  assert.deepEqual(recorder.recorded, [], "and so no provider may be recorded");
});

test("a rejected spec never claims a provider was contacted", async () => {
  const recorder = provenanceRecorder();
  const legacySpec = { schemaVersion: "v1", assetKind: "image" } as unknown as AssetGenerationSpecV1;

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", fetchImpl: async () => imageResponse(await pngBytes()) });
  await assert.rejects(() => Promise.resolve(executor(job(), legacySpec, recorder.context(new AbortController().signal))), /production-v1 image spec/);

  assert.deepEqual(recorder.recorded, []);
});

test("the static renderer reports no provenance at all -- it contacts nothing", async () => {
  const recorder = provenanceRecorder();
  const executor = buildStaticRendererExecutor();
  await executor(job(), spec(), recorder.context(new AbortController().signal));

  assert.deepEqual(recorder.recorded, []);
});

test("the durable pair and the rich provenance object never disagree about provider or model", async () => {
  const recorder = provenanceRecorder();
  let rich: GenerativeImageProvenance | null = null;
  const fetchImpl: typeof fetch = async () => imageResponse(await pngBytes());

  const executor = buildCloudflareGenerativeImageExecutor({
    accountId: "a",
    apiToken: "t",
    model: "@cf/some/other-model",
    fetchImpl,
    onProvenance: (captured) => {
      rich = captured;
    },
  });
  await executor(job(), spec(), recorder.context(new AbortController().signal));

  const captured = rich as unknown as GenerativeImageProvenance;
  assert.equal(recorder.recorded[0].provider, captured.provider);
  assert.equal(recorder.recorded[0].model, captured.model);
});

// --- one canonical model-normalization rule ----------------------------------------------------------

test("an empty or whitespace-only model falls back to the default, from every entry point", () => {
  assert.equal(resolveCloudflareModel(undefined), DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL);
  assert.equal(resolveCloudflareModel(""), DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL);
  assert.equal(resolveCloudflareModel("   "), DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL);
  assert.equal(resolveCloudflareModel("@cf/some/other-model"), "@cf/some/other-model");
  assert.equal(resolveCloudflareModel("  @cf/padded/model  "), "@cf/padded/model");

  // The env reader and a programmatic config must agree -- `||` and `??` did not.
  assert.equal(cloudflareGenerativeImageConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_GENERATIVE_IMAGE_MODEL: "" }).model, DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL);
  assert.equal(cloudflareGenerativeImageConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_GENERATIVE_IMAGE_MODEL: "   " }).model, DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL);
});

test("an empty programmatic model cannot produce a malformed URL or an empty persisted model", async () => {
  const recorder = provenanceRecorder();
  let calledUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    calledUrl = String(input);
    return imageResponse(await pngBytes());
  };

  const executor = buildCloudflareGenerativeImageExecutor({ accountId: "a", apiToken: "t", model: "", fetchImpl });
  await executor(job(), spec(), recorder.context(new AbortController().signal));

  // Previously `config.model ?? DEFAULT` let "" through, giving an endpoint ending in "/ai/run/".
  assert.doesNotMatch(calledUrl, /\/ai\/run\/$/);
  // endsWith rather than a built regex: the model id contains regex metacharacters.
  assert.ok(decodeURIComponent(calledUrl).endsWith(DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL), `endpoint should end with the default model, got: ${calledUrl}`);
  assert.equal(recorder.recorded[0].model, DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL, "an empty model must never be persisted as this attempt's model");
});
