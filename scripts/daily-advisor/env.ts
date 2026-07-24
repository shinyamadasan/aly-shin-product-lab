import { existsSync, readFileSync } from "node:fs";

// Minimal, dependency-free .env-style loader -- this worker runs outside Next.js (which only
// auto-loads .env.local for `next dev`/`next build`), so it needs its own loading step. Deliberately
// simple: KEY=VALUE lines only, no quoting/escaping beyond a trim, no interpolation. Real
// environment variables (already set before this runs) always win over the file, matching standard
// dotenv precedence -- so a scheduled task can still override via its own environment if needed.
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export type SupabaseAdvisorCredentials = {
  url: string;
  anonKey: string;
  email: string;
  password: string;
};

// Required only when --source supabase is used -- sample mode never reads these, so a missing
// credential file doesn't block development/test runs. Returns the specific missing key names
// rather than a generic message, so a misconfigured .env.advisor.local is fast to fix.
export function readSupabaseCredentials(): { ok: true; credentials: SupabaseAdvisorCredentials } | { ok: false; missing: string[] } {
  const url = process.env.ADVISOR_SUPABASE_URL;
  const anonKey = process.env.ADVISOR_SUPABASE_ANON_KEY;
  const email = process.env.ADVISOR_SUPABASE_EMAIL;
  const password = process.env.ADVISOR_SUPABASE_PASSWORD;

  const missing: string[] = [];
  if (!url) missing.push("ADVISOR_SUPABASE_URL");
  if (!anonKey) missing.push("ADVISOR_SUPABASE_ANON_KEY");
  if (!email) missing.push("ADVISOR_SUPABASE_EMAIL");
  if (!password) missing.push("ADVISOR_SUPABASE_PASSWORD");

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, credentials: { url: url!, anonKey: anonKey!, email: email!, password: password! } };
}

export function readTimezone(cliValue: string | undefined): string {
  return cliValue || process.env.ADVISOR_TIMEZONE || "Asia/Manila";
}

export function readClaudeBinary(): string {
  return process.env.ADVISOR_CLAUDE_BIN || "claude";
}
