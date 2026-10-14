"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Product } from "../lib/product-lab-types";
import { supabase } from "../lib/supabase";
import { listMediaForProduct, type ProductMedia, type ProductMediaClient } from "../lib/product-media";
import { CAROUSEL_FILE_NAMES, CAROUSEL_ZIP_FILE_NAME, MEDIA_ROLE_LABELS, MEDIA_ROLES, REEL_FILE_NAME } from "../lib/content-studio/creative-plan";
import { createStoredZip, validateCarouselExport } from "../lib/content-studio/export-output";
import { offerProblems, type FastModeRequest } from "../lib/content-studio/fast-mode-request";

// Content Studio Fast Mode -- the owner's quick path: product, format, five of their own photos or
// clips, a confirmed offer, then Generate -> Preview -> Export.
//
// The browser never decides anything that matters: the server re-reads the product and media under the
// owner's sign-in and refuses anything that is not their own media. The preview holds the exact bytes
// the server returned, and Export packages those same bytes, so what was inspected is what is saved.
// Nothing is kept on the server; leaving this screen discards the result.

type Format = FastModeRequest["format"];
type Output =
  | { format: "carousel"; slides: { name: string; bytes: Uint8Array; url: string }[] }
  | { format: "reel"; bytes: Uint8Array; url: string };

const fieldStyle = "h-11 min-w-0 rounded-md border border-current/20 bg-white px-3 text-base!";
const buttonStyle = "min-h-11 rounded-md border border-current/20 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50";
const primaryStyle = "min-h-11 rounded-md bg-[#8f5632] px-4 py-2 text-sm font-semibold text-white hover:bg-[#774427] disabled:opacity-50";

async function defaultToken(): Promise<string | null> {
  const session = await supabase?.auth.getSession();
  return session?.data.session?.access_token ?? null;
}

function download(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function messageFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) return body.message;
  } catch { /* fall through */ }
  return "This could not be made just now. Try again.";
}

export function ContentStudioFastMode({
  products,
  onExit,
  client = supabase as unknown as ProductMediaClient | null,
  getToken = defaultToken,
}: {
  products: Product[];
  onExit: () => void;
  client?: ProductMediaClient | null;
  getToken?: () => Promise<string | null>;
}) {
  const [productId, setProductId] = useState("");
  const [format, setFormat] = useState<Format>("carousel");
  const [media, setMedia] = useState<ProductMedia[]>([]);
  const [mediaMessage, setMediaMessage] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState("");
  const [cta, setCta] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reelAvailable, setReelAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState<Output | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const outputRef = useRef<Output | null>(null);

  const product = products.find((candidate) => candidate.id === productId) ?? null;
  const usable = media.filter((item) => format === "reel" || item.mediaType === "photo");

  // Media for the chosen product only: another product's food never appears as a choice.
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(async () => {
      if (!client || !productId) {
        setMedia([]);
        return;
      }
      setMediaMessage("Loading media…");
      const result = await listMediaForProduct(client, productId);
      if (!current) return;
      if (result.ok) {
        setMedia(result.value);
        setMediaMessage("");
      } else setMediaMessage(result.message);
    }, 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [client, productId]);

  // Whether this server can make a Reel, asked once, before the owner fills anything in for one.
  useEffect(() => {
    if (format !== "reel" || reelAvailable !== null) return;
    let current = true;
    void (async () => {
      const token = await getToken();
      try {
        const response = await fetch("/api/content-studio/reel", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const body = response.ok ? ((await response.json()) as { available?: boolean }) : {};
        if (current) setReelAvailable(body.available === true);
      } catch {
        if (current) setReelAvailable(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [format, getToken, reelAvailable]);

  const clearOutput = useCallback(() => {
    const previous = outputRef.current;
    if (previous?.format === "carousel") previous.slides.forEach((slide) => URL.revokeObjectURL(slide.url));
    if (previous?.format === "reel") URL.revokeObjectURL(previous.url);
    outputRef.current = null;
    setOutput(null);
  }, []);

  useEffect(() => clearOutput, [clearOutput]);

  function togglePick(id: string) {
    setPicked((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : ids.length < MEDIA_ROLES.length ? [...ids, id] : ids));
  }

  const offer = { priceAmount: Number(price), unit, cta, confirmed };
  const problems = [
    ...(product ? [] : ["Pick a product."]),
    ...(picked.length === MEDIA_ROLES.length ? [] : [`Pick ${MEDIA_ROLES.length} ${format === "carousel" ? "photos" : "photos or clips"} (${picked.length} picked).`]),
    ...offerProblems(offer),
    ...(format === "reel" && reelAvailable === false ? ["Reels can only be made on the studio computer right now."] : []),
  ];

  async function generate() {
    if (problems.length > 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const token = await getToken();
      if (!token) {
        setError("Sign in again to create content.");
        return;
      }
      const request: FastModeRequest = { format, productId, mediaIds: picked, offer };
      const headers = { "content-type": "application/json", Authorization: `Bearer ${token}` };

      if (format === "carousel") {
        const responses = await Promise.all(
          CAROUSEL_FILE_NAMES.map((_, i) => fetch("/api/content-studio/carousel", { method: "POST", headers, body: JSON.stringify({ ...request, slide: i + 1 }) })),
        );
        const failed = responses.find((response) => !response.ok);
        if (failed) {
          setError(await messageFrom(failed));
          return;
        }
        const files = await Promise.all(responses.map(async (response, i) => ({ name: CAROUSEL_FILE_NAMES[i], bytes: new Uint8Array(await response.arrayBuffer()) })));
        if (validateCarouselExport(files).length > 0) {
          setError("A slide did not come out right. Try again.");
          return;
        }
        clearOutput();
        const next: Output = { format: "carousel", slides: files.map((file) => ({ ...file, url: URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: "image/png" })) })) };
        outputRef.current = next;
        setOutput(next);
        setSlideIndex(0);
      } else {
        const response = await fetch("/api/content-studio/reel", { method: "POST", headers, body: JSON.stringify(request) });
        if (!response.ok) {
          setError(await messageFrom(response));
          return;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0 || !response.headers.get("content-type")?.startsWith("video/mp4")) {
          setError("The Reel did not come out right. Try again.");
          return;
        }
        clearOutput();
        const next: Output = { format: "reel", bytes, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "video/mp4" })) };
        outputRef.current = next;
        setOutput(next);
      }
    } catch {
      setError("This could not be made just now. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function exportOutput() {
    if (!output) return;
    if (output.format === "carousel") {
      const files = output.slides.map(({ name, bytes }) => ({ name, bytes }));
      if (validateCarouselExport(files).length > 0) {
        setError("These slides cannot be exported. Make them again.");
        return;
      }
      download(createStoredZip(files), CAROUSEL_ZIP_FILE_NAME, "application/zip");
    } else {
      download(output.bytes, REEL_FILE_NAME, "video/mp4");
    }
  }

  if (output) {
    return (
      <section aria-label="Preview" className="min-w-0 space-y-5 text-foreground">
        <div>
          <h2 className="text-xl font-semibold">Preview</h2>
          <p className="mt-1 text-sm opacity-75">
            {product?.name} · {output.format === "carousel" ? "Carousel, 5 slides" : "Reel"}. Check every {output.format === "carousel" ? "slide" : "second"} before you export.
          </p>
        </div>
        {output.format === "carousel" ? (
          <div className="space-y-3">
            <div aria-label="Slides" className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
              {output.slides.map((slide, i) => (
                <figure className="w-[78%] max-w-sm shrink-0 snap-center sm:w-72" key={slide.name}>
                  {/* Object URLs of the exact bytes being exported; the image optimizer must not touch them. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt={`Slide ${i + 1} of 5`} className="aspect-[4/5] w-full rounded-md border border-current/15 object-cover" onClick={() => setSlideIndex(i)} src={slide.url} />
                  <figcaption className="mt-1 text-xs opacity-75">Slide {i + 1} of 5</figcaption>
                </figure>
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <button className={buttonStyle} disabled={slideIndex === 0} onClick={() => setSlideIndex((i) => i - 1)} type="button">Previous</button>
                <p className="text-sm">Slide {slideIndex + 1} of 5</p>
                <button className={buttonStyle} disabled={slideIndex === 4} onClick={() => setSlideIndex((i) => i + 1)} type="button">Next</button>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={`Slide ${slideIndex + 1} full size`} className="w-full max-w-md rounded-md border border-current/15" src={output.slides[slideIndex].url} />
            </div>
          </div>
        ) : (
          <video aria-label="Reel preview" className="aspect-[9/16] w-full max-w-xs rounded-md border border-current/15 bg-black" controls playsInline src={output.url} />
        )}
        {error ? <p className="text-sm" role="alert">{error}</p> : null}
        <div className="flex flex-wrap gap-3">
          <button className={buttonStyle} disabled={busy} onClick={() => { setError(""); clearOutput(); }} type="button">Back</button>
          <button className={buttonStyle} disabled={busy} onClick={() => void generate()} type="button">{busy ? "Making it again…" : "Regenerate"}</button>
          <button className={primaryStyle} disabled={busy} onClick={exportOutput} type="button">Export</button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Create content" className="min-w-0 space-y-5 text-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Create content</h2>
          <p className="mt-1 text-sm opacity-75">A carousel or Reel made from your own photos and videos, with the offer you confirm.</p>
        </div>
        <button className={buttonStyle} onClick={onExit} type="button">Back to creatives</button>
      </div>

      <label className="grid min-w-0 gap-1 text-sm font-medium">
        Product
        <select className={fieldStyle} disabled={busy} onChange={(e) => { setProductId(e.target.value); setPicked([]); }} value={productId}>
          <option value="">Select a product</option>
          {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Format</legend>
        <div className="flex flex-wrap gap-3">
          {(["carousel", "reel"] as const).map((value) => (
            <button
              aria-pressed={format === value}
              className={`${buttonStyle} ${format === value ? "border-[#8f5632]! bg-[#fff2d8]!" : ""}`}
              disabled={busy}
              key={value}
              onClick={() => { setFormat(value); setPicked((ids) => (value === "carousel" ? ids.filter((id) => media.find((m) => m.id === id)?.mediaType === "photo") : ids)); }}
              type="button"
            >
              {value === "carousel" ? "Carousel" : "Reel"}
            </button>
          ))}
        </div>
        <p className="text-sm opacity-75">
          {format === "carousel"
            ? "5 photo slides (1080 × 1350)."
            : "An 11-second vertical video. Clips play as filmed; photos are shown still with a slow zoom."}
        </p>
        {format === "reel" && reelAvailable === false ? <p className="text-sm" role="status">Reels can only be made on the studio computer right now. You can make a carousel here.</p> : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Media</legend>
        <p className="text-sm opacity-75">
          Pick {MEDIA_ROLES.length} in order: {MEDIA_ROLES.map((role, i) => `${i + 1} ${MEDIA_ROLE_LABELS[role].toLowerCase()}`).join(", ")}. Only media assigned to this product is shown.
        </p>
        {!productId ? <p className="text-sm">Select a product to see its media.</p> : null}
        {mediaMessage ? <p className="text-sm" role="status">{mediaMessage}</p> : null}
        {productId && !mediaMessage && usable.length === 0 ? (
          <p className="text-sm">No {format === "carousel" ? "photos" : "media"} for this product yet. Add them in Media first.</p>
        ) : null}
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {usable.map((item) => {
            const order = picked.indexOf(item.id);
            return (
              <button
                aria-label={`${order >= 0 ? `Picked ${order + 1}: ${MEDIA_ROLE_LABELS[MEDIA_ROLES[order]]}. ` : ""}${item.originalFilename}`}
                aria-pressed={order >= 0}
                className={`relative min-w-0 overflow-hidden rounded-md border-2 bg-white text-left ${order >= 0 ? "border-[#8f5632]" : "border-transparent"}`}
                disabled={busy}
                key={item.id}
                onClick={() => togglePick(item.id)}
                type="button"
              >
                <div className="aspect-square bg-background">
                  {item.previewUrl ? item.mediaType === "video" ? (
                    <video className="h-full w-full object-cover" muted playsInline preload="metadata" src={item.previewUrl} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" className="h-full w-full object-cover" loading="lazy" src={item.previewUrl} />
                  ) : <span className="block p-2 text-xs">Preview unavailable</span>}
                </div>
                <span className="block truncate px-2 py-1 text-xs">{item.mediaType === "video" ? `Video · ${((item.durationMs ?? 0) / 1000).toFixed(1)}s` : "Photo"}</span>
                {order >= 0 ? (
                  <span className="absolute left-1 top-1 rounded bg-[#8f5632] px-2 py-0.5 text-xs font-semibold text-white">{order + 1} · {MEDIA_ROLE_LABELS[MEDIA_ROLES[order]]}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="grid min-w-0 gap-3 rounded-lg border border-current/15 p-4 sm:grid-cols-3">
        <legend className="px-1 text-sm font-medium">Offer</legend>
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          Price (₱)
          <input className={fieldStyle} disabled={busy} inputMode="decimal" min="0" onChange={(e) => { setPrice(e.target.value); setConfirmed(false); }} placeholder="160" step="0.01" type="number" value={price} />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          Selling unit
          <input className={fieldStyle} disabled={busy} maxLength={24} onChange={(e) => { setUnit(e.target.value); setConfirmed(false); }} placeholder="2 pcs" value={unit} />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          Call to action
          <input className={fieldStyle} disabled={busy} maxLength={40} onChange={(e) => { setCta(e.target.value); setConfirmed(false); }} placeholder="Message us to order" value={cta} />
        </label>
        <label className="flex items-start gap-2 text-sm sm:col-span-3">
          <input checked={confirmed} className="mt-1 h-5 w-5" disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} type="checkbox" />
          <span>This price, selling unit and call to action are current and correct. They will appear exactly as typed.</span>
        </label>
      </fieldset>

      {problems.length > 0 ? (
        <ul aria-label="Still needed" className="space-y-1 text-sm opacity-80">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
      ) : null}
      {error ? <p className="break-words rounded-md border border-current/20 p-3 text-sm" role="alert">{error}</p> : null}
      <button className={primaryStyle} disabled={busy || problems.length > 0} onClick={() => void generate()} type="button">
        {busy ? (format === "reel" ? "Making your Reel… this can take a few minutes" : "Making your slides…") : "Generate"}
      </button>
    </section>
  );
}
