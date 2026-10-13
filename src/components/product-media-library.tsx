"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Product } from "../lib/product-lab-types";
import { supabase } from "../lib/supabase";
import { ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS } from "../lib/asset-file-urls";
import {
  changeMediaProduct, listMediaForProduct, uploadProductMediaBatch, PRODUCT_MEDIA_ACCEPT,
  type ProductMedia, type ProductMediaClient,
} from "../lib/product-media";

// globals.css's unlayered `font: inherit` otherwise overrides Tailwind's font-size utility.
const selectStyle = "h-11 min-w-0 rounded-md border border-current/20 bg-white px-3 text-base!";
const buttonStyle = "min-h-11 rounded-md border border-current/20 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50";
// Re-sign at 80% of the URL lifetime, before an open preview can expire.
const PREVIEW_REFRESH_MS = ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS * 1000 * 0.8;

export function ProductMediaLibrary({ products, client = supabase as unknown as ProductMediaClient | null }: { products: Product[]; client?: ProductMediaClient | null }) {
  const [media, setMedia] = useState<ProductMedia[]>([]);
  const [filter, setFilter] = useState<string | null | undefined>(undefined);
  const [uploadProduct, setUploadProduct] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const mutationRef = useRef(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (!client) { setLoading(false); return; }
    setLoading(true);
    const result = await listMediaForProduct(client, filter);
    if (request !== requestRef.current) return;
    setLoading(false);
    if (result.ok) { setMedia(result.value); setMessage(""); }
    else setMessage(result.message);
  }, [client, filter]);

  useEffect(() => {
    const requests = requestRef;
    const initial = window.setTimeout(() => void refresh(), 0);
    // Refresh expiring signed URLs while open, and after returning to the browser tab.
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, PREVIEW_REFRESH_MS);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { ++requests.current; window.clearTimeout(initial); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  async function upload(files: File[]) {
    if (!client || mutationRef.current || files.length === 0) return;
    mutationRef.current = true;
    setBusy(true);
    setErrors([]);
    try {
      const results = await uploadProductMediaBatch(client, files, uploadProduct || null,
        (name, index) => setProgress(`Adding ${index + 1} of ${files.length}: ${name}`));
      const failures = results.flatMap(({ filename, result }) => result.ok ? [] : [`${filename}: ${result.message}`]);
      await refresh();
      setErrors(failures);
      setProgress(`Added ${results.length - failures.length} of ${results.length} files.`);
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }

  async function assign(item: ProductMedia, productId: string) {
    if (!client || mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    setProgress("Saving product…");
    setErrors([]);
    const result = await changeMediaProduct(client, item.id, productId || null);
    if (result.ok) await refresh();
    else setErrors([`${item.originalFilename}: ${result.message}`]);
    mutationRef.current = false;
    setBusy(false);
    setProgress("");
  }

  if (!client) return <p className="text-sm">Sign in to the connected Product Lab to save and reuse your photos and videos.</p>;

  return (
    <section aria-label="Media library" className="min-w-0 space-y-5 text-foreground">
      <div>
        <h2 className="text-xl font-semibold">Media</h2>
        <p className="mt-1 text-sm opacity-75">Keep your real product photos and videos here, ready to reuse.</p>
      </div>
      <div className="grid min-w-0 gap-3 rounded-lg border border-current/15 p-4 sm:grid-cols-[1fr_auto]">
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          Product for these uploads
          <select className={selectStyle} disabled={busy} onChange={(e) => setUploadProduct(e.target.value)} value={uploadProduct}>
            <option value="">Unassigned</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </label>
        <button className={`${buttonStyle} self-end`} disabled={busy} onClick={() => inputRef.current?.click()} type="button">+ Add photos/videos</button>
        <input accept={PRODUCT_MEDIA_ACCEPT} aria-label="Add photos/videos" className="hidden" disabled={busy} multiple onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void upload(files); }} ref={inputRef} type="file" />
        <p className="text-sm opacity-75 sm:col-span-2">JPEG, PNG, WebP up to 10 MB · H.264 MP4 up to 50 MB. MOV/HEVC needs conversion first.</p>
      </div>
      <div aria-label="Media filters" className="flex flex-wrap items-end gap-3">
        <button aria-pressed={filter === undefined} className={buttonStyle} disabled={busy} onClick={() => setFilter(undefined)} type="button">All</button>
        <label className="order-first grid w-full min-w-0 gap-1 text-sm font-medium sm:order-none sm:w-auto">
          Filter by product
          <select className={`${selectStyle} max-w-full`} disabled={busy} onChange={(e) => setFilter(e.target.value === "" ? undefined : e.target.value === "unassigned" ? null : e.target.value)} value={filter === undefined ? "" : filter === null ? "unassigned" : filter}>
            <option value="">All products</option><option value="unassigned">Unassigned</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </label>
        <button className={buttonStyle} disabled={busy || loading} onClick={() => void refresh()} type="button">Refresh previews</button>
      </div>
      <p aria-live="polite" className="break-words text-sm">{busy ? progress || "Saving…" : progress}</p>
      {errors.length > 0 ? <ul className="space-y-2 rounded-md border border-current/20 p-3 text-sm" role="alert">{errors.map((error, index) => <li className="break-words" key={index}>{error}</li>)}</ul> : null}
      {message ? <p role="alert">{message}</p> : null}
      {selectedIds.length > 0 ? <div className="flex flex-wrap items-center gap-3 text-sm"><p>{selectedIds.length} selected for creative work</p><button className={buttonStyle} onClick={() => setSelectedIds([])} type="button">Clear selection</button></div> : null}
      {loading ? <p className="text-sm">Loading media…</p> : null}
      {!loading && !message && media.length === 0 ? <p className="text-sm">{filter === undefined ? "No media yet. Add your first photos or videos." : "No media for this product yet."}</p> : null}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {media.map((item) => (
          <article className="min-w-0 overflow-hidden rounded-lg border border-current/15 bg-white" key={item.id}>
            <div className="aspect-[4/3] bg-background">
              {item.previewUrl ? item.mediaType === "video" ? (
                <video aria-label={`Preview ${item.originalFilename}`} className="h-full w-full object-contain" controls playsInline preload="metadata" src={item.previewUrl} />
              ) : (
                // Signed URLs expire; a native img avoids the image optimizer caching them.
                // eslint-disable-next-line @next/next/no-img-element
                <img alt={item.originalFilename} className="h-full w-full object-contain" loading="lazy" src={item.previewUrl} />
              ) : <p className="p-4 text-sm">Preview unavailable. Try Refresh previews.</p>}
            </div>
            <div className="space-y-3 p-4">
              <p className="break-words text-sm font-medium">{item.originalFilename}</p>
              <div className="flex flex-wrap gap-2 text-xs opacity-75"><span>{item.mediaType === "video" ? "Video" : "Photo"}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString()}</time></div>
              <label className="grid gap-1 text-sm font-medium">Product
                <select aria-label={`Product for ${item.originalFilename}`} className={`${selectStyle} w-full`} disabled={busy} onChange={(e) => void assign(item, e.target.value)} value={item.productId ?? ""}>
                  <option value="">Unassigned</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                </select>
              </label>
              <button aria-pressed={selectedIds.includes(item.id)} className={`${buttonStyle} w-full`} onClick={() => setSelectedIds((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])} type="button">{selectedIds.includes(item.id) ? "Selected" : "Select"}</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
