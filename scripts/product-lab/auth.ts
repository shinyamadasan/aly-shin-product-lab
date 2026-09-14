import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertUnprivilegedSupabaseProjectKey } from "../inventory-operator/credentials.ts";
import { authenticateOwnerWith, isProductionOwner, type OwnerPrincipal } from "../../src/lib/production-auth.ts";

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

// A. Static Product Lab project configuration -- the Supabase URL and publishable/anon key. This
// never carries a principal and is safe to build once per process (stdio) or once per cold start
// (remote); it says WHICH project to talk to, never WHO is talking.
export type ProductLabProjectConfig = {
  url: string;
  publishableKey: string;
};

export function readProductLabProjectConfig(env: NodeJS.ProcessEnv = process.env): ProductLabProjectConfig {
  const url = env.PRODUCT_LAB_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY
    ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) {
    throw new ProductLabError(
      "configuration_error",
      "Set PRODUCT_LAB_SUPABASE_URL and PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY",
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
  return { url, publishableKey };
}

function createProjectScopedClient(config: ProductLabProjectConfig, accessToken: string): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// B. Per-request authenticated owner context. Validates ONE presented access token against Supabase
// Auth (a real round trip -- never a local JWT decode for the authorization decision) and requires
// app_metadata.app_role === "owner", reusing the exact same rule the web app's production gate
// already enforces (production-auth.ts's isProductionOwner / is_product_lab_owner() in SQL are the
// same equality test -- see that file's own commentary). This is the one place Product Lab MCP
// decides who a caller is; it never trusts a caller-supplied identity.
export type ProductLabOwnerContext = {
  client: SupabaseClient;
  ownerId: string;
  ownerEmail: string;
};

export async function authenticateProductLabRequest(
  config: ProductLabProjectConfig,
  accessToken: string | null | undefined,
): Promise<ProductLabOwnerContext> {
  const token = accessToken?.trim();
  if (!token) {
    throw new ProductLabError("authentication_failed", "Owner access token is required");
  }

  const result = await authenticateOwnerWith(
    { headers: new Headers({ Authorization: `Bearer ${token}` }) },
    {
      createClient: (t) => createProjectScopedClient(config, t),
      getUser: async (client, t) => {
        const { data, error } = await client.auth.getUser(t);
        return error || !data.user
          ? null
          : { id: data.user.id, email: data.user.email ?? null, appMetadata: data.user.app_metadata };
      },
    },
  );

  if (!result.ok) {
    throw new ProductLabError("authentication_failed", "Owner token validation failed");
  }
  const principal: OwnerPrincipal<SupabaseClient> = result.principal;
  if (!isProductionOwner(principal)) {
    throw new ProductLabError("authorization_failed", "Authenticated user is not a Product Lab owner");
  }
  return { client: principal.client, ownerId: principal.id, ownerEmail: principal.email };
}

// Local stdio adapter: the SAME per-token authentication function above, sourced from a
// process-global environment token instead of a per-request bearer header. This is a compatibility
// shim for the local/debug path (docs/PRODUCT_LAB_MCP.md); it must never gain logic of its own.
export type ProductLabCredentials = ProductLabProjectConfig & {
  ownerAccessToken: string;
};

export function readProductLabCredentials(env: NodeJS.ProcessEnv = process.env): ProductLabCredentials {
  const config = readProductLabProjectConfig(env);
  const ownerAccessToken = env.PRODUCT_LAB_OWNER_ACCESS_TOKEN;
  if (!ownerAccessToken) {
    throw new ProductLabError("configuration_error", "Set PRODUCT_LAB_OWNER_ACCESS_TOKEN");
  }
  return { ...config, ownerAccessToken };
}

export async function authenticatedProductLabClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupabaseClient> {
  const credentials = readProductLabCredentials(env);
  const context = await authenticateProductLabRequest(credentials, credentials.ownerAccessToken);
  return context.client;
}
