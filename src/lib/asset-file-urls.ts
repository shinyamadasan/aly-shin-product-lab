import type { AssetFileRecord } from "./asset-files.ts";

export const GENERATED_ASSETS_SIGNED_URL_BUCKET = "generated-assets";
export const ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS = 300;

type SupabaseErrorLike = {
  message: string;
};

type SignedUrlResult = PromiseLike<{ data: { signedUrl?: string } | null; error: SupabaseErrorLike | null }>;

export type AssetFileUrlClient = {
  storage: {
    from(bucket: typeof GENERATED_ASSETS_SIGNED_URL_BUCKET): {
      createSignedUrl(path: string, expiresIn: typeof ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS): SignedUrlResult;
    };
  };
};

export type AssetFileSignedUrlResult =
  | { ok: true; signedUrl: string; expiresInSeconds: typeof ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS }
  | { ok: false; reason: "unsupported-bucket" | "failed"; message: string };

export async function createSignedUrlForAssetFile(client: AssetFileUrlClient, file: AssetFileRecord): Promise<AssetFileSignedUrlResult> {
  if (file.storageBucket !== GENERATED_ASSETS_SIGNED_URL_BUCKET) {
    return {
      ok: false,
      reason: "unsupported-bucket",
      message: "Signed URLs are only available for generated Asset files in the private generated-assets bucket.",
    };
  }

  const result = await client.storage.from(GENERATED_ASSETS_SIGNED_URL_BUCKET).createSignedUrl(file.storagePath, ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS);
  if (result.error || !result.data?.signedUrl) {
    return { ok: false, reason: "failed", message: result.error?.message ?? "Generated Asset signed URL could not be created." };
  }

  return { ok: true, signedUrl: result.data.signedUrl, expiresInSeconds: ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS };
}
