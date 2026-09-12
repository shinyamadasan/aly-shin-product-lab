export type AllowedSupabaseProjectKey = "publishable" | "legacy_anon";

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function assertUnprivilegedSupabaseProjectKey(key: string): AllowedSupabaseProjectKey {
  if (key !== key.trim() || !key) {
    throw new Error("Supabase project key must be a publishable key or legacy anon JWT");
  }
  if (/^sb_publishable_[A-Za-z0-9._-]+$/.test(key)) {
    return "publishable";
  }
  if (key.startsWith("sb_")) {
    throw new Error("Privileged or unsupported Supabase project keys are not allowed");
  }

  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("Supabase project key must be a publishable key or legacy anon JWT");
  }
  try {
    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);
    if (!header || typeof header !== "object" || Array.isArray(header)
      || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid JWT shape");
    }
    const role = (payload as { role?: unknown }).role;
    if (role === "anon") {
      return "legacy_anon";
    }
    if (role === "service_role") {
      throw new Error("Privileged Supabase service-role project keys are not allowed");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("not allowed")) throw error;
    throw new Error("Supabase project key must be a publishable key or legacy anon JWT");
  }
  throw new Error("Supabase project key must be a publishable key or legacy anon JWT");
}
