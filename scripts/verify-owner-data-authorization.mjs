// SECURITY S1 authorization probe -- the OWNER-BUSINESS data domain.
//
// Companion to scripts/verify-owner-authorization.mjs, which covers the creative/production domain
// Wave B closed. This one covers everything Wave B deliberately left alone: recipes, costing,
// inventory, purchases, suppliers, journal, brand, selling formats, and the ordering tables.
//
//   node scripts/verify-owner-data-authorization.mjs
//
// Run it BEFORE and AFTER applying supabase-harden-product-lab-owner-data-rls.sql.
//
// HOW TO READ THE OUTPUT -- this matters, and the Wave B probe's wording got it wrong.
//
//   A restrictive RLS policy does NOT make SELECT fail. The `authenticated` role keeps its table
//   GRANT, so the request succeeds and RLS filters every row out of it. The honest verdict for a
//   denied principal is therefore "0 rows", not an error, and the only way to tell "denied" from
//   "the table happens to be empty" is to compare principals. That is why every table below is
//   probed with EVERY principal in one run and the counts are printed side by side.
//
//   VISIBLE(n)  the principal can read n rows
//   EMPTY       0 rows -- filtered by RLS, or genuinely empty. Compare across columns.
//   DENIED      a real error (42501 missing grant, or 401 with no session)
//
// The OWNER path is deliberately NOT probed: that would mean handling the owner's password. The
// owner side is verified through the application instead, exactly as Wave B did.
//
// SAFETY. Read-only. Every table probe is `select(head: true, count: exact)` -- it returns a COUNT
// and never a row. No insert, no update, no delete, no storage write. It prints verdicts and counts
// only: never a JWT, password, API key, email, user id, object path or column value.

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

// Grouped the way the S1 brief groups them, so the report reads as the decision it documents.
const GROUPS = [
  {
    label: "A. OWNER-ONLY BUSINESS DATA (target: owner, and nobody else)",
    tables: [
      "ingredients",
      "ingredient_aliases",
      "purchase_imports",
      "purchase_import_rows",
      "inventory_transactions",
      "supply_entries",
      "equipment",
      "costing_entries",
      "batch_photos",
      "content_journal",
      "content_drafts",
      "ai_reviews",
      "selling_format_packaging_lines",
      "customers",
    ],
  },
  {
    label: "A2. OWNER DATA THE WORKER PROVABLY READS (target: owner + creative_worker)",
    tables: ["tasting_feedback", "brand_profiles", "opportunities"],
  },
  {
    label: "B. PUBLIC CATALOG (target: owner writes; public-order reads)",
    tables: ["products", "product_batches", "costing_summaries", "selling_formats"],
  },
  {
    label: "C. ORDERING DOMAIN (target: owner + public-order)",
    tables: ["orders", "order_lines"],
  },
  {
    label: "D. CREATIVE / PRODUCTION (hardened by Wave B -- regression check only)",
    tables: ["creative_jobs", "creative_job_attempts", "creative_packages", "asset_jobs", "asset_job_attempts", "assets", "asset_files"],
  },
];

const ALL_TABLES = GROUPS.flatMap((group) => group.tables);

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

function verdict(result) {
  if (result.error) return "DENIED(" + (result.error.code ?? result.error.message) + ")";
  const count = result.count ?? 0;
  return count === 0 ? "EMPTY" : "VISIBLE(" + count + ")";
}

async function countsForSession(client) {
  const counts = {};
  for (const table of ALL_TABLES) {
    counts[table] = verdict(await client.from(table).select("*", { count: "exact", head: true }));
  }
  return counts;
}

async function signedInCounts(label, email, password) {
  if (!email || !password) {
    console.log("  " + label + ": credentials not present locally -- SKIPPED");
    return { claim: "(skipped)", counts: null };
  }
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    console.log("  " + label + ": sign-in FAILED (" + (error?.status ?? "?") + ")");
    return { claim: "(sign-in failed)", counts: null };
  }
  const claim = claimOf(data.session.access_token);
  const counts = await countsForSession(client);
  await client.auth.signOut();
  return { claim, counts };
}

async function anonymousCounts() {
  const counts = {};
  for (const table of ALL_TABLES) {
    const res = await fetch(URL_ + "/rest/v1/" + table + "?select=*&limit=1", {
      headers: { apikey: ANON, Authorization: "Bearer " + ANON, Prefer: "count=exact", Range: "0-0" },
    });
    if (!res.ok) {
      let code = "";
      try {
        code = JSON.parse(await res.text()).code ?? "";
      } catch {
        /* body is not JSON; the status is the verdict */
      }
      counts[table] = "DENIED(" + res.status + (code ? "," + code : "") + ")";
      continue;
    }
    const range = res.headers.get("content-range") ?? "";
    const total = Number(range.split("/")[1] ?? "0");
    counts[table] = total > 0 ? "VISIBLE(" + total + ")" : "EMPTY";
  }
  return counts;
}

// --- storage ------------------------------------------------------------------------------------
//
// READ-ONLY. Wave B's probe uploaded and removed a marker file; this one only lists, because an
// upload into `batch-photos` would put a stray object in a PUBLIC bucket the owner's app reads.

async function storageListVerdict(email, password, bucket) {
  if (!email || !password) return "(skipped)";
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !session.session) return "(sign-in failed)";
  const { data, error } = await client.storage.from(bucket).list("", { limit: 20 });
  await client.auth.signOut();
  if (error) return "DENIED(" + error.message + ")";
  return (data ?? []).length === 0 ? "EMPTY" : "LISTABLE(" + data.length + "+ entries)";
}

// --- run ----------------------------------------------------------------------------------------

console.log("SECURITY S1 -- Product Lab owner-data authorization probe");
console.log("Read-only. Counts only; no row content is fetched or printed.\n");

const publicOrder = await signedInCounts("PUBLIC-ORDER", order.PUBLIC_ORDER_SUPABASE_EMAIL, order.PUBLIC_ORDER_SUPABASE_PASSWORD);
const worker = await signedInCounts("WORKER", advisor.ADVISOR_SUPABASE_EMAIL, advisor.ADVISOR_SUPABASE_PASSWORD);
const anonymous = await anonymousCounts();

console.log("  public-order principal  app_metadata.app_role = " + publicOrder.claim);
console.log("  worker principal        app_metadata.app_role = " + worker.claim);
console.log("  anonymous               (anon key, no session)\n");

const cell = (value) => String(value ?? "-").padEnd(18);
for (const group of GROUPS) {
  console.log("--- " + group.label);
  console.log("    " + "table".padEnd(32) + cell("PUBLIC-ORDER") + cell("WORKER") + cell("ANON"));
  for (const table of group.tables) {
    console.log("    " + table.padEnd(32) + cell(publicOrder.counts?.[table]) + cell(worker.counts?.[table]) + cell(anonymous[table]));
  }
  console.log("");
}

console.log("--- STORAGE (list only; no write probe)");
console.log("    " + "bucket".padEnd(32) + cell("PUBLIC-ORDER") + cell("WORKER"));
for (const bucket of ["batch-photos", "generated-assets"]) {
  const po = await storageListVerdict(order.PUBLIC_ORDER_SUPABASE_EMAIL, order.PUBLIC_ORDER_SUPABASE_PASSWORD, bucket);
  const wk = await storageListVerdict(advisor.ADVISOR_SUPABASE_EMAIL, advisor.ADVISOR_SUPABASE_PASSWORD, bucket);
  console.log("    " + bucket.padEnd(32) + cell(po) + cell(wk));
}

console.log("\n  EMPTY vs VISIBLE across the columns is the verdict. A row that is VISIBLE to the");
console.log("  worker and EMPTY for public-order is RLS filtering, not an empty table.");
