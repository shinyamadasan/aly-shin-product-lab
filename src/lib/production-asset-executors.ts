import { readFile } from "node:fs/promises";

import { inspectAssetBytes, type SupportedGeneratedAssetMimeType } from "./asset-binary.ts";
import { sha256Hex } from "./asset-digest.ts";
import type { AssetJobExecutor } from "./asset-jobs.ts";
import { isProductionSpecV1, type ProductionSpecV1 } from "./production-spec.ts";
import { renderProductionStaticImage } from "./production-static-renderer.ts";

// Production MVP Wave B -- the two machine executors the Production Route selects, and nothing else.
//
// The split this module implements is the accepted one and is not renegotiated here:
//
//   generative_image -> an EXPRESSIVE image from a provider, composed under the static renderer
//   static_renderer  -> EXACT typography, composition and branding, deterministically
//
// Provider and model are CONFIGURATION, never identity: every provider-specific fact below reaches
// this module through CloudflareGenerativeImageConfig, so swapping providers is a config change plus
// one new executor builder, not a rewrite of the seam.

// --- provider identity -----------------------------------------------------------------------------

export const GENERATIVE_IMAGE_PROVIDER = "cloudflare-workers-ai";
export const DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
const DEFAULT_CLOUDFLARE_ENDPOINT_BASE_URL = "https://api.cloudflare.com/client/v4";

// --- executor timeouts (review section 9) ----------------------------------------------------------
//
// The runner's generic 30s default was chosen for the mock/external executors, where "execution" is
// an in-process copy of bytes a human already produced. Inheriting it for a generative image call was
// an accident of ordering, not a decision: a diffusion model behind a provider queue routinely takes
// longer than 30s to answer, so the legacy default would have reported ordinary provider latency as
// a job timeout.
//
// These are the explicit per-executor values the trusted runner passes, and they are deliberately
// FINITE -- an unbounded wait turns one slow provider call into a permanently "running" job, and this
// schema has no stale-attempt recovery function to clean that up.
export const PRODUCTION_EXECUTOR_TIMEOUTS_MS = {
  // Deterministic, local, CPU-bound: satori + resvg + sharp over one frame. Measured in hundreds of
  // milliseconds; this is a generous ceiling, not a target.
  static_renderer: 30_000,
  // One provider round trip, plus at most one bounded transport retry and its backoff.
  generative_image: 120_000,
} as const;

// --- transient transport failure (review section 9) ------------------------------------------------
//
// TRANSPORT reliability only. This is emphatically NOT creative-quality regeneration: a 200 response
// carrying a disappointing illustration is a creative outcome the owner reviews, never something this
// module silently re-rolls. Only the statuses below -- provider-side rate limiting and gateway
// unavailability, all of which mean the request never really ran -- are retried.
export const TRANSIENT_GENERATIVE_IMAGE_HTTP_STATUSES: readonly number[] = [429, 502, 503, 504];

// One initial request plus at most ONE retry. A constant rather than config, so no caller can turn
// this into a retry storm against a provider that is already rate limiting us.
export const MAX_GENERATIVE_IMAGE_TRANSPORT_ATTEMPTS = 2;

// Retry-After is honoured, but never blindly: a provider asking for a fifteen minute wait must not
// hold the executor past its own timeout, so the honoured delay is clamped.
export const MAX_GENERATIVE_IMAGE_RETRY_DELAY_MS = 10_000;
const DEFAULT_GENERATIVE_IMAGE_RETRY_DELAY_MS = 500;

// --- reference image safety (review section 10) ----------------------------------------------------
//
// Reference images are operator-approved style anchors read off local disk via
// GENERATIVE_IMAGE_REFERENCE_PATHS. They are still UNTRUSTED INPUT from this executor's point of
// view: a path can be edited, moved, or point at something that is not an image at all.
//
// So every reference is fully decoded and identified before any of it reaches the provider. Nothing
// is uploaded on the strength of its file extension, and an unreadable or unsupported file fails the
// job loudly rather than being skipped into a silently reference-free generation -- a generation that
// quietly dropped its references would produce off-brand art with no signal that anything went wrong.
export const MAX_GENERATIVE_IMAGE_REFERENCES = 4;
export const MAX_GENERATIVE_IMAGE_REFERENCE_BYTES = 4 * 1024 * 1024;

// Deliberately the same three types the generated-asset pipeline already admits, sniffed from real
// magic bytes by inspectAssetBytes rather than trusted from a filename.
export const ALLOWED_GENERATIVE_IMAGE_REFERENCE_MIME_TYPES: readonly SupportedGeneratedAssetMimeType[] = ["image/png", "image/jpeg", "image/webp"];

// What we can honestly say about a reference AFTER decoding it. sha256 is the identity that answers
// "which approved reference influenced this generation" without storing the file itself.
export type GenerativeImageReferenceProvenance = {
  fileName: string;
  mimeType: SupportedGeneratedAssetMimeType;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
};

type LoadedReference = GenerativeImageReferenceProvenance & { bytes: Uint8Array<ArrayBuffer> };

// --- provenance (review section 4) -----------------------------------------------------------------
//
// Everything needed to answer "which provider produced this generative asset, with which model, on
// which attempt, influenced by which references".
//
// promptSha256, never the prompt itself. asset_job_attempts' own header states the rule this follows:
// that table holds bounded, redacted operator-facing diagnostics -- never stack traces, prompts, raw
// provider requests/responses, or credentials. A digest keeps the prompt identifiable across runs
// without persisting its text.
export type GenerativeImageProvenance = {
  provider: typeof GENERATIVE_IMAGE_PROVIDER;
  model: string;
  endpoint: string;
  // How many transport attempts this execution actually spent (1 when the first request succeeded).
  transportAttempts: number;
  promptSha256: string;
  references: GenerativeImageReferenceProvenance[];
};

export type CloudflareGenerativeImageConfig = {
  accountId: string;
  apiToken: string;
  model?: string;
  endpointBaseUrl?: string;
  referenceImagePaths?: string[];
  fetchImpl?: typeof fetch;
  onRawImage?: (raw: { bytes: Uint8Array; mimeType: SupportedGeneratedAssetMimeType; prompt: string; model: string }) => void | Promise<void>;
  // Called once per execution, immediately after a successful generation, with the provenance of the
  // call that actually produced the bytes.
  onProvenance?: (provenance: GenerativeImageProvenance) => void | Promise<void>;
};

function requireProductionImageSpec(spec: unknown): ProductionSpecV1 {
  if (!isProductionSpecV1(spec) || spec.assetKind !== "image") {
    throw new Error("Production image executors require a production-v1 image spec.");
  }
  return spec;
}

export function buildStaticRendererExecutor(): AssetJobExecutor {
  return async (_job, spec) => [await renderProductionStaticImage(requireProductionImageSpec(spec))];
}

export function buildGenerativeImagePrompt(spec: ProductionSpecV1): string {
  const brief = spec.visualBrief;
  const scene = brief?.scene.join(" ") ?? spec.copy.caption;
  const notes = brief?.executionNotes.join(" ") ?? "";

  return [
    "Create a text-free expressive illustration for a square social post.",
    "Warm hand-drawn editorial bakery style, simple human characters are allowed, cream background, charming minimal composition.",
    "Do not generate readable text, logos, captions, signatures, UI, labels, or branding.",
    "Use reference input only for broad visual language: warmth, palette, simplified linework, texture, density. Do not copy exact artwork, characters, pose, joke, text, or composition.",
    "The imagery must stay visibly illustrated or doodled, not photoreal product documentation.",
    "Desserts must read as ordinary bakery food: neat brownies, blondies, pastry slices, or clean crumb texture.",
    "Avoid flesh-like texture, skin-like tearing, grotesque food, ambiguous goo, slop, malformed pastry anatomy, severe fusion, body-horror, mutilation, or peeling layers.",
    `Concept: ${brief?.concept ?? spec.copy.headline}`,
    `Style: ${brief?.style ?? "warm editorial bakery illustration"}`,
    `Scene: ${scene}`,
    notes ? `Constraints: ${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ONE canonical model-normalization rule, used by every reader of config.model.
//
// `??` was wrong here: it only falls back on undefined, so a programmatic `{ model: "" }` (or a
// whitespace-only value) survived as an empty model, which produced an endpoint ending in "/ai/run/"
// and would have persisted an empty string as this attempt's model. The env reader already collapsed
// empty to the default with `||`; this makes the two agree, everywhere, in one place.
export function resolveCloudflareModel(model: string | undefined): string {
  return model?.trim() || DEFAULT_CLOUDFLARE_GENERATIVE_IMAGE_MODEL;
}

function cloudflareEndpoint(config: CloudflareGenerativeImageConfig): string {
  const base = config.endpointBaseUrl ?? DEFAULT_CLOUDFLARE_ENDPOINT_BASE_URL;
  return `${base}/accounts/${config.accountId}/ai/run/${resolveCloudflareModel(config.model)}`;
}

function referenceFileName(referencePath: string, index: number): string {
  return referencePath.split(/[\\/]/).pop() || `reference-${index}.png`;
}

// Reads, size-checks and DECODES every configured reference before the executor touches the network.
// Throws on the first bad one -- see the safety note on the constants above for why a bad reference
// is never quietly dropped.
export async function loadGenerativeImageReferences(paths: readonly string[]): Promise<LoadedReference[]> {
  if (paths.length > MAX_GENERATIVE_IMAGE_REFERENCES) {
    throw new Error(`At most ${MAX_GENERATIVE_IMAGE_REFERENCES} generative image references are allowed; ${paths.length} were configured.`);
  }

  const loaded: LoadedReference[] = [];
  for (const [index, referencePath] of paths.entries()) {
    const fileName = referenceFileName(referencePath, index);

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await readFile(referencePath));
    } catch (err) {
      throw new Error(`Generative image reference could not be read: ${fileName} (${err instanceof Error ? err.message : String(err)}).`);
    }

    if (bytes.length === 0) {
      throw new Error(`Generative image reference is empty: ${fileName}.`);
    }
    if (bytes.length > MAX_GENERATIVE_IMAGE_REFERENCE_BYTES) {
      throw new Error(`Generative image reference ${fileName} is ${bytes.length} bytes, over the ${MAX_GENERATIVE_IMAGE_REFERENCE_BYTES} byte limit.`);
    }

    const inspected = await inspectAssetBytes(bytes);
    if (!inspected.ok) {
      throw new Error(`Generative image reference ${fileName} is not a supported image: ${inspected.message}`);
    }
    if (!ALLOWED_GENERATIVE_IMAGE_REFERENCE_MIME_TYPES.includes(inspected.facts.actualMimeType)) {
      throw new Error(`Generative image reference ${fileName} has unsupported type ${inspected.facts.actualMimeType}.`);
    }

    loaded.push({
      fileName,
      mimeType: inspected.facts.actualMimeType,
      byteSize: bytes.length,
      width: inspected.facts.actualWidth,
      height: inspected.facts.actualHeight,
      sha256: inspected.facts.sha256,
      bytes,
    });
  }

  return loaded;
}

// Built fresh per transport attempt: a FormData whose body stream has already been consumed by a
// failed request cannot be re-sent, so a retry that reused one would fail for a reason that has
// nothing to do with the provider. Reference bytes are read once, before this, and reused in memory.
function buildGenerativeImageForm(prompt: string, references: readonly LoadedReference[]): FormData {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "1024");
  for (const [index, reference] of references.entries()) {
    form.append(`input_image_${index}`, new Blob([reference.bytes], { type: reference.mimeType }), reference.fileName);
  }
  return form;
}

// Seconds or an HTTP-date, per RFC 9110. Anything unparseable, non-positive, or absent falls back to
// the small fixed delay; anything larger than the ceiling is clamped rather than honoured.
export function parseRetryAfterMs(headerValue: string | null, now: number = Date.now()): number {
  if (!headerValue) {
    return DEFAULT_GENERATIVE_IMAGE_RETRY_DELAY_MS;
  }

  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  const millis = trimmed !== "" && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - now;

  if (!Number.isFinite(millis) || millis <= 0) {
    return DEFAULT_GENERATIVE_IMAGE_RETRY_DELAY_MS;
  }
  return Math.min(millis, MAX_GENERATIVE_IMAGE_RETRY_DELAY_MS);
}

// Abort-aware: a runner timeout that fires mid-backoff rejects immediately instead of sleeping out
// the remaining delay first.
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cloudflare Workers AI retry was aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cloudflare Workers AI retry was aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestGenerativeImage(
  config: CloudflareGenerativeImageConfig,
  prompt: string,
  references: readonly LoadedReference[],
  signal: AbortSignal,
): Promise<{ response: Response; transportAttempts: number }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = cloudflareEndpoint(config);

  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiToken}` },
      body: buildGenerativeImageForm(prompt, references),
      signal,
    });

    if (response.ok) {
      return { response, transportAttempts: attempt };
    }

    const isTransient = TRANSIENT_GENERATIVE_IMAGE_HTTP_STATUSES.includes(response.status);
    if (!isTransient || attempt >= MAX_GENERATIVE_IMAGE_TRANSPORT_ATTEMPTS) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Cloudflare Workers AI request failed with ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
    }

    const retryDelayMs = parseRetryAfterMs(response.headers.get("retry-after"));
    // Drain before retrying so the failed response cannot hold its connection open.
    await response.text().catch(() => "");
    await delay(retryDelayMs, signal);
  }
}

// Handles both documented Cloudflare Workers AI response shapes, and trusts NEITHER content-type
// header for the resulting media type: the bytes are decoded and identified by inspectAssetBytes, the
// same decoder the rest of the asset pipeline already uses. A response that is not a decodable
// PNG/JPEG/WebP fails here with that reason, rather than being mislabelled image/png by a fallback
// and then failing further downstream with a less useful message.
export async function readCloudflareImageBytes(response: Response): Promise<{ bytes: Uint8Array; mimeType: SupportedGeneratedAssetMimeType }> {
  const contentType = response.headers.get("content-type") ?? "";

  let bytes: Uint8Array;
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as { result?: { image?: string }; errors?: Array<{ message?: string }> };
    const image = payload.result?.image;
    if (typeof image !== "string" || image.length === 0) {
      const providerErrors = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(providerErrors || "Cloudflare Workers AI response did not include image bytes.");
    }
    bytes = new Uint8Array(Buffer.from(image, "base64"));
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  const inspected = await inspectAssetBytes(bytes);
  if (!inspected.ok) {
    throw new Error(`Cloudflare Workers AI returned bytes that are not a supported image: ${inspected.message}`);
  }

  return { bytes, mimeType: inspected.facts.actualMimeType };
}

export function buildCloudflareGenerativeImageExecutor(config: CloudflareGenerativeImageConfig): AssetJobExecutor {
  return async (_job, spec, context) => {
    const productionSpec = requireProductionImageSpec(spec);
    const prompt = buildGenerativeImagePrompt(productionSpec);
    const model = resolveCloudflareModel(config.model);

    // Before the network call, on purpose: an invalid reference should never cost a provider request.
    // It is also before recordProvenance below, and that ordering is the contract: a reference set
    // this executor refuses means no provider was ever contacted, and the attempt must not claim one.
    const references = await loadGenerativeImageReferences(config.referenceImagePaths ?? []);

    // Provider and model are settled and a request is about to be made. Reported to the runner HERE,
    // not after success, so a failed or timed-out attempt still persists which provider and model
    // were actually used -- the single source of truth for both this and the richer
    // GenerativeImageProvenance below is the same pair of locals, never re-derived downstream.
    context.recordProvenance?.({ provider: GENERATIVE_IMAGE_PROVIDER, model });

    const { response, transportAttempts } = await requestGenerativeImage(config, prompt, references, context.signal);
    const illustration = await readCloudflareImageBytes(response);

    await config.onRawImage?.({ ...illustration, prompt, model });
    await config.onProvenance?.({
      provider: GENERATIVE_IMAGE_PROVIDER,
      model,
      endpoint: cloudflareEndpoint(config),
      transportAttempts,
      promptSha256: await sha256Hex(new TextEncoder().encode(prompt)),
      // Identity only -- the reference BYTES deliberately do not travel into provenance.
      references: references.map((reference) => ({
        fileName: reference.fileName,
        mimeType: reference.mimeType,
        byteSize: reference.byteSize,
        width: reference.width,
        height: reference.height,
        sha256: reference.sha256,
      })),
    });

    return [await renderProductionStaticImage(productionSpec, { illustration })];
  };
}

// Splits on ";" rather than "," because a Windows absolute path contains no ";" but may legitimately
// contain "," -- the same separator this platform's own PATH-style variables use.
export function parseGenerativeImageReferencePaths(value: string | undefined): string[] {
  return value?.split(";").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

// Takes the three named variables it reads, not a whole ProcessEnv: this function has no interest in
// NODE_ENV or anything else on the process, and typing it that narrowly is what lets a test hand it a
// three-key object instead of fabricating an entire environment.
export function cloudflareGenerativeImageConfigFromEnv(env: Record<string, string | undefined> = process.env): CloudflareGenerativeImageConfig {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for generative_image.");
  }
  return {
    accountId,
    apiToken,
    model: resolveCloudflareModel(env.CLOUDFLARE_GENERATIVE_IMAGE_MODEL),
    referenceImagePaths: parseGenerativeImageReferencePaths(env.GENERATIVE_IMAGE_REFERENCE_PATHS),
  };
}
