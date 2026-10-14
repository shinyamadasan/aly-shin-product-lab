import { createSignedUrlForPrivateMedia } from "../asset-file-urls.ts";
import { PRODUCT_MEDIA_BUCKET } from "../product-media.ts";
import { MediaUnreadableError, type MediaSourceReader } from "./campaign-media.ts";
import type { CreativeMedia } from "./creative-spec.ts";
import { FastModeRequestError, type FastModeRequest, type TrustedMediaRow, type TrustedProduct } from "./fast-mode-request.ts";

// Content Studio Fast Mode -- reads the product and the five Media Library rows the request names,
// with the OWNER'S client, so RLS decides what exists. Nothing here is read from the request body
// except the ids.

type DbResult<T> = PromiseLike<{ data: T | null; error: { code?: string; message: string } | null }>;

export type SourceMediaRow = TrustedMediaRow & { storage_bucket: string; storage_path: string };

export type FastModeSourceClient = {
  from(table: "products"): { select(columns: "id,name"): { eq(column: "id", value: string): { maybeSingle(): DbResult<TrustedProduct> } } };
  from(table: "product_media"): {
    select(columns: "id,product_id,media_type,duration_ms,storage_bucket,storage_path"): { in(column: "id", values: string[]): DbResult<SourceMediaRow[]> };
  };
  storage: {
    from(bucket: typeof PRODUCT_MEDIA_BUCKET): {
      download(path: string): DbResult<Blob>;
      createSignedUrl(path: string, expiresIn: number): DbResult<{ signedUrl?: string }>;
    };
  };
};

const LOAD_FAILED = "Your product or media could not be loaded. Check your connection and sign-in, then try again.";

export async function loadFastModeSources(
  client: FastModeSourceClient,
  request: FastModeRequest,
): Promise<{ product: TrustedProduct | null; mediaRows: SourceMediaRow[] }> {
  const [product, media] = await Promise.all([
    client.from("products").select("id,name").eq("id", request.productId).maybeSingle(),
    client.from("product_media").select("id,product_id,media_type,duration_ms,storage_bucket,storage_path").in("id", request.mediaIds),
  ]);
  if (product.error || media.error) {
    const missingSetup = [product.error, media.error].some((error) => error?.code === "42P01" || error?.code === "PGRST205");
    throw new FastModeRequestError(503, missingSetup ? "Media needs one-time setup. Ask Shin to enable the media library, then reload." : LOAD_FAILED);
  }
  // Never read bytes from a bucket a row merely claims; only the private product-media library.
  const mediaRows = (media.data ?? []).filter((row) => row.storage_bucket === PRODUCT_MEDIA_BUCKET);
  return { product: product.data, mediaRows };
}

export function productMediaReader(client: FastModeSourceClient, rows: SourceMediaRow[]): MediaSourceReader {
  const pathOf = (media: CreativeMedia): string => {
    const id = media.source.kind === "product_media" ? media.source.mediaId : null;
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new MediaUnreadableError(media.id, `Media "${media.id}" is not a Media Library item.`);
    return row.storage_path;
  };
  return {
    async readPhoto(media) {
      const result = await client.storage.from(PRODUCT_MEDIA_BUCKET).download(pathOf(media));
      if (result.error || !result.data) throw new MediaUnreadableError(media.id, `Media "${media.id}" could not be downloaded.`);
      return new Uint8Array(await result.data.arrayBuffer());
    },
    async videoUrl(media) {
      const signed = await createSignedUrlForPrivateMedia(client, PRODUCT_MEDIA_BUCKET, pathOf(media));
      if (!signed.ok) throw new MediaUnreadableError(media.id, `Media "${media.id}" could not be opened.`);
      return signed.signedUrl;
    },
  };
}
