import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertUnprivilegedSupabaseProjectKey } from "../inventory-operator/credentials.ts";

export type ProductLabErrorCode =
  | "configuration_error"
  | "credential_rejected"
  | "authentication_failed"
  | "authorization_failed"
  | "read_failed"
  | "state_error"
  | "preview_error"
  | "apply_failed"
  | "verification_failed";

export class ProductLabError extends Error {
  readonly code: ProductLabErrorCode;

  constructor(
    code: ProductLabErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductLabError";
    this.code = code;
  }
}

export type ProductLabCredentials = {
  url: string;
  publishableKey: string;
  ownerAccessToken: string;
};

export function readProductLabCredentials(env: NodeJS.ProcessEnv = process.env): ProductLabCredentials {
  const url = env.PRODUCT_LAB_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY
    ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const ownerAccessToken = env.PRODUCT_LAB_OWNER_ACCESS_TOKEN;
  if (!url || !publishableKey || !ownerAccessToken) {
    throw new ProductLabError(
      "configuration_error",
      "Set PRODUCT_LAB_SUPABASE_URL, PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY, and PRODUCT_LAB_OWNER_ACCESS_TOKEN",
    );
  }
  try {
    assertUnprivilegedSupabaseProjectKey(publishableKey);
  } catch (error) {
    throw new ProductLabError(
      "credential_rejected",
      error instanceof Error ? error.message : String(error),
    );
  }
  return { url, publishableKey, ownerAccessToken };
}

export async function authenticatedProductLabClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupabaseClient> {
  const credentials = readProductLabCredentials(env);
  const client = createClient(credentials.url, credentials.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${credentials.ownerAccessToken}` } },
  });
  const { data, error } = await client.auth.getUser(credentials.ownerAccessToken);
  if (error || !data.user) {
    throw new ProductLabError(
      "authentication_failed",
      `Owner token validation failed: ${error?.message ?? "no authenticated user"}`,
    );
  }
  if (data.user.app_metadata?.app_role !== "owner") {
    throw new ProductLabError("authorization_failed", "Authenticated user is not a Product Lab owner");
  }
  return client;
}
