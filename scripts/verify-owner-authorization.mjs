// Wave B authorization verification probe.
//
// Run this BEFORE and AFTER applying supabase-harden-creative-production-rls.sql to prove the
// boundary actually moved. It signs in as the two NON-OWNER principals whose credentials already
// live in this repo's local env files, and reports what each can reach.
//
//   node scripts/verify-owner-authorization.mjs
//
// The OWNER path is deliberately NOT probed here: that would mean handling the owner's password.
// Verify the owner side through the app instead -- sign in, open /content-studio, confirm Saved
// Creatives lists and a ?job= link reopens. The app exercises exactly the same policies.
//
// SAFETY. This script is read-only apart from one write probe into a clearly-marked throwaway
// storage path, which it removes in the same run. It prints verdicts only -- never a JWT, password,
// API key, email, user id, object path or row value.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The worker credential files live at the MAIN checkout root. When this runs inside a git worktree
// (.worktrees/<name>/) that is two levels up, so both locations are tried rather than assumed.
function envFile(name) {
  const file = [path.join(ROOT, name), path.join(ROOT, "..", "..", name)].find((candidate) => existsSync(candidate));
  if (!file) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
}

const local = envFile(".env.local");
const order = envFile(".env.public-order.local");
const advisor = envFile(".env.advisor.local");

const URL_ = local.NEXT_PUBLIC_SUPABASE_URL;
const ANON = local.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !ANON) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not found in .env.local");
  process.exit(2);
}

const DOMAIN_TABLES = [
  "creative_jobs",
  "creative_job_attempts",
  "creative_packages",
  "asset_jobs",
  "asset_job_attempts",
  "assets",
  "asset_files",
];

const BUCKET = "generated-assets";

// Reads only the SHAPE of the claim, never the token.
function claimOf(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString("utf8"));
    const app = payload.app_metadata ?? null;
    const role = app && typeof app === "object" && typeof app.app_role === "string" ? app.app_role : null;
    return role === null ? "(no app_role claim)" : JSON.stringify(role);
  } catch {
    return "(unreadable)";
  }
}

async function probeTables(client) {
  for (const table of DOMAIN_TABLES) {
    const result = await client.from(table).select("*", { count: "exact", head: true });
    console.log(`    ${table.padEnd(24)} ${result.error ? `DENIED (${result.error.code ?? result.error.message})` : `READABLE (${result.count ?? "?"} rows)`}`);
  }
}

async function probeStorage(client) {
  const bucket = client.storage.from(BUCKET);

  // Walk to a real object without revealing any path.
  let prefix = "";
  let target = null;
  for (let depth = 0; depth < 5 && target === null; depth += 1) {
    const { data, error } = await bucket.list(prefix, { limit: 20 });
    if (error) {
      console.log(`    list objects             DENIED (${error.message})`);
      return;
    }
    if (!data || data.length === 0) break;
    const file = data.find((entry) => entry.id !== null);
    if (file) {
      target = prefix ? `${prefix}/${file.name}` : file.name;
      break;
    }
    const dir = data.find((entry) => entry.id === null);
    if (!dir) break;
    prefix = prefix ? `${prefix}/${dir.name}` : dir.name;
  }

  console.log(`    list objects             ${target === null ? "ALLOWED but nothing reachable" : "ALLOWED"}`);

  if (target !== null) {
    const signed = await bucket.createSignedUrl(target, 30);
    console.log(`    create signed URL        ${signed.error ? `DENIED (${signed.error.message})` : "ALLOWED"}`);
    const download = await bucket.download(target);
    console.log(`    download object          ${download.error ? `DENIED (${download.error.message})` : `ALLOWED (${(await download.data.arrayBuffer()).byteLength} bytes)`}`);
  }

  // A 1x1 PNG (an allowed mime type for this bucket) into an obviously disposable prefix.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const probePath = "authz-probe/.probe-delete-me.png";
  const upload = await bucket.upload(probePath, png, { upsert: true, contentType: "image/png" });
  console.log(`    upload object            ${upload.error ? `DENIED (${upload.error.message})` : "ALLOWED"}`);
  if (!upload.error) {
    const removed = await bucket.remove([probePath]);
    console.log(`    delete object            ${removed.error ? `DENIED (${removed.error.message})` : "ALLOWED (probe artifact removed)"}`);
  }
}

async function probePrincipal(label, email, password) {
  console.log(`\n=== ${label} ===`);
  if (!email || !password) {
    console.log("  credentials not present locally -- SKIPPED");
    return;
  }
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    console.log(`  sign-in FAILED (${error?.status ?? "?"})`);
    return;
  }
  console.log(`  app_metadata.app_role  : ${claimOf(data.session.access_token)}`);
  await probeTables(client);
  await probeStorage(client);
  await client.auth.signOut();
}

async function probeAnonymous() {
  console.log("\n=== ANONYMOUS (anon key, no session) ===");
  for (const table of DOMAIN_TABLES) {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=id&limit=1`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    });
    let code = "";
    try {
      code = JSON.parse(await res.text()).code ?? "";
    } catch {
      /* body is not JSON; the status is the verdict */
    }
    console.log(`    ${table.padEnd(24)} ${res.ok ? "READABLE  <-- UNEXPECTED" : `DENIED (HTTP ${res.status}${code ? `, ${code}` : ""})`}`);
  }
}

console.log("Wave B authorization probe");
console.log("Expected AFTER hardening: every line below is DENIED.");

await probePrincipal("PUBLIC-ORDER website principal", order.PUBLIC_ORDER_SUPABASE_EMAIL, order.PUBLIC_ORDER_SUPABASE_PASSWORD);
await probePrincipal("ADVISOR / WORKER automation principal", advisor.ADVISOR_SUPABASE_EMAIL, advisor.ADVISOR_SUPABASE_PASSWORD);
console.log("\n  NOTE: the advisor/worker principal is EXPECTED to stay READABLE/ALLOWED once it holds");
console.log("        app_role = 'creative_worker'. It runs the generation pipeline. Only the");
console.log("        public-order principal and anonymous must be fully denied.");
await probeAnonymous();
