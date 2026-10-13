import { buildAssetUploadCandidate } from "./asset-upload-intake.ts";
import { maxGeneratedAssetFileSizeBytes } from "./asset-generation-validation.ts";
import { createSignedUrlForPrivateMedia } from "./asset-file-urls.ts";

export const PRODUCT_MEDIA_BUCKET = "product-media";
export const PRODUCT_MEDIA_ACCEPT = ".jpg,.jpeg,.png,.webp,.mp4";

export type ProductMediaRow = {
  id: string;
  product_id: string | null;
  media_type: "photo" | "video";
  storage_bucket: typeof PRODUCT_MEDIA_BUCKET;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  width: number;
  height: number;
  duration_ms: number | null;
  created_at: string;
};

export type ProductMedia = {
  id: string;
  productId: string | null;
  mediaType: "photo" | "video";
  originalFilename: string;
  createdAt: string;
  width: number;
  height: number;
  durationMs: number | null;
  previewUrl: string | null;
};

type DbResult<T> = PromiseLike<{ data: T | null; error: { code?: string; message: string } | null }>;
type MediaQuery = DbResult<ProductMediaRow[]> & {
  eq(column: string, value: string): MediaQuery;
  is(column: string, value: null): MediaQuery;
  order(column: string, options: { ascending: boolean }): MediaQuery;
};
export type ProductMediaClient = {
  from(table: "product_media"): {
    select(columns: string): MediaQuery;
    insert(row: Omit<ProductMediaRow, "created_at">): { select(columns: string): { single(): DbResult<ProductMediaRow> } };
    update(row: { product_id: string | null }): { eq(column: string, value: string): { select(columns: string): { maybeSingle(): DbResult<ProductMediaRow> } } };
  };
  storage: {
    from(bucket: typeof PRODUCT_MEDIA_BUCKET): {
      upload(path: string, bytes: Uint8Array, options: { contentType: string; upsert: false }): DbResult<unknown>;
      createSignedUrl(path: string, expiresIn: number): DbResult<{ signedUrl?: string }>;
    };
  };
};

export type MediaResult<T> = { ok: true; value: T } | { ok: false; message: string };

function describeMediaError(error: { code?: string; message: string }): string {
  return error.code === "42P01" || error.code === "PGRST205"
    ? "Media needs one-time setup. Ask Shin to enable the media library, then reload."
    : "Media could not be saved or loaded. Check your connection and sign-in, then try again.";
}

async function withPreview(client: ProductMediaClient, row: ProductMediaRow): Promise<ProductMedia> {
  // Never trust a persisted URL or sign a different bucket/path supplied by a row.
  let previewUrl: string | null = null;
  try {
    if (row.storage_bucket === PRODUCT_MEDIA_BUCKET) {
      const preview = await createSignedUrlForPrivateMedia(client, PRODUCT_MEDIA_BUCKET, row.storage_path);
      if (preview.ok) previewUrl = preview.signedUrl;
    }
  } catch { /* Keep the saved item visible when signing is temporarily unavailable. */ }
  return {
    id: row.id, productId: row.product_id, mediaType: row.media_type,
    originalFilename: row.original_filename, createdAt: row.created_at,
    width: row.width, height: row.height, durationMs: row.duration_ms,
    previewUrl,
  };
}

// No account-id filter: the existing owner claim scopes the shared business library in RLS.
// undefined = All, null = Unassigned, string = one product. URLs are short-lived read results.
export async function listMediaForProduct(client: ProductMediaClient, productId?: string | null): Promise<MediaResult<ProductMedia[]>> {
  try {
    let query = client.from("product_media").select("*");
    if (productId === null) query = query.is("product_id", null);
    else if (productId !== undefined) query = query.eq("product_id", productId);
    const result = await query.order("created_at", { ascending: false }).order("id", { ascending: false });
    if (result.error) return { ok: false, message: describeMediaError(result.error) };
    return { ok: true, value: await Promise.all((result.data ?? []).map((row) => withPreview(client, row))) };
  } catch {
    return { ok: false, message: "Media could not be loaded. Check your connection and try again." };
  }
}

export async function changeMediaProduct(client: ProductMediaClient, id: string, productId: string | null): Promise<MediaResult<ProductMedia>> {
  try {
    const result = await client.from("product_media").update({ product_id: productId }).eq("id", id).select("*").maybeSingle();
    if (result.error) return { ok: false, message: describeMediaError(result.error) };
    if (!result.data) return { ok: false, message: "This media is no longer available. Reload the library." };
    return { ok: true, value: await withPreview(client, result.data) };
  } catch {
    return { ok: false, message: "The product could not be changed. Check your connection and reload." };
  }
}

export async function uploadProductMedia(client: ProductMediaClient, file: File, productId: string | null): Promise<MediaResult<ProductMedia>> {
  try {
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension === "mov" || file.type === "video/quicktime") {
      return { ok: false, message: "MOV is not supported yet. Export an H.264 MP4 and add that file." };
    }
    const kind = extension === "mp4" ? "short_video" : "image";
    if (!(kind === "short_video" || ["jpg", "jpeg", "png", "webp"].includes(extension ?? ""))) {
      return { ok: false, message: "Use JPEG, PNG, WebP photos or H.264 MP4 videos. HEIC/HEVC needs conversion first." };
    }
    const limit = maxGeneratedAssetFileSizeBytes(kind);
    if (file.size > limit) return { ok: false, message: `This file is too large. ${kind === "image" ? "Photos: 10 MB" : "Videos: 50 MB"} maximum.` };
    const intake = await buildAssetUploadCandidate(new Uint8Array(await file.arrayBuffer()), kind);
    if (!intake.ok) {
      return { ok: false, message: intake.reason === "unsupported-video-codec"
        ? "HEVC and other video codecs are not supported yet. Export an H.264 MP4."
        : "This file could not be read as a supported photo or H.264 MP4. Export a new copy and try again." };
    }
    const candidate = intake.candidate;
    const id = crypto.randomUUID();
    const suffix = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" }[candidate.mimeType];
    const path = `${id}.${suffix}`;
    const uploaded = await client.storage.from(PRODUCT_MEDIA_BUCKET).upload(path, candidate.bytes, { contentType: candidate.mimeType, upsert: false });
    if (uploaded.error) return { ok: false, message: "Upload failed. Check your connection and sign-in, then try again." };
    const saved = await client.from("product_media").insert({
      id, product_id: productId, media_type: kind === "short_video" ? "video" : "photo",
      storage_bucket: PRODUCT_MEDIA_BUCKET, storage_path: path,
      original_filename: file.name.slice(0, 255), mime_type: candidate.mimeType,
      file_size_bytes: candidate.fileSizeBytes, width: candidate.width!, height: candidate.height!, duration_ms: candidate.durationMs,
    }).select("*").single();
    if (saved.error || !saved.data) {
      // A network error can arrive AFTER commit. Preserve the private object; never undo an
      // uncertain write. Reload before re-uploading so any committed row becomes visible.
      return { ok: false, message: "The file uploaded, but saving it could not be confirmed. Reload the library before trying again." };
    }
    return { ok: true, value: await withPreview(client, saved.data) };
  } catch {
    return { ok: false, message: "The upload could not be confirmed. Reload the library and check your connection before trying again." };
  }
}

// Sequential to bound phone memory; each failure stays local to its file.
export async function uploadProductMediaBatch(client: ProductMediaClient, files: File[], productId: string | null, onFile?: (name: string, index: number) => void) {
  const results: Array<{ filename: string; result: MediaResult<ProductMedia> }> = [];
  for (const [index, file] of files.entries()) {
    onFile?.(file.name, index);
    results.push({ filename: file.name, result: await uploadProductMedia(client, file, productId) });
  }
  return results;
}
