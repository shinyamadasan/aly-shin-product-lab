// Owner-session correction of ONE mistaken refund, with a before/after proof. DRY-RUN BY DEFAULT.
//
//   node scripts/correct-mistaken-refund.mjs --order <uuid> --refunded-at <exact value> --amount <n> --reason "<text>"
//   node scripts/correct-mistaken-refund.mjs ... --operation-id <uuid> --apply
//
// It signs in AS THE OWNER (never with a service key) using OWNER_SUPABASE_URL / OWNER_SUPABASE_ANON_KEY /
// OWNER_SUPABASE_EMAIL / OWNER_SUPABASE_PASSWORD, read from the environment or from the git-ignored
// .env.owner.local, and calls public.correct_mistaken_refund -- the same audited function the Orders screen uses.
// Every rule (owner, reason length, echo of refunded_at and amount, 7-day window, not cancelled, once per order)
// is enforced by the DATABASE; this script decides nothing, it only shows what will be sent and proves what changed.
//
// Without --apply it only READS: it prints the order, the stock/COGS facts that must not change, the global
// counts, and exactly what would be sent, then stops. With --apply it makes ONE call, then re-reads everything and
// FAILS (exit 1) if anything other than payment_status, refunded_at and updated_at changed on the order, if any
// count moved, if the stock or COGS facts moved, or if the audit row is missing.
//
// RETRIES: pass the SAME --operation-id again. A repeated id replays the first answer instead of correcting twice.
//
// It never prints the password, a token, a key, a customer name or contact detail.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };
const apply = args.includes("--apply");

const orderId = flag("order");
const refundedAt = flag("refunded-at");
const amount = flag("amount") === undefined ? NaN : Number(flag("amount"));
const reason = flag("reason");
const operationId = flag("operation-id") ?? crypto.randomUUID();

const fail = (message) => { console.error(`FAILED: ${message}`); process.exit(1); };
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId ?? "")) fail("--order must be the full order uuid");
if (!refundedAt || !Number.isFinite(Date.parse(refundedAt))) fail("--refunded-at must be the order's refunded_at exactly as stored (copy it from the dry run)");
if (!Number.isFinite(amount) || amount <= 0) fail("--amount must be the order's paid_amount");
if (!reason || reason.trim().length < 10 || reason.trim().length > 300) fail("--reason must be 10 to 300 characters");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) fail("--operation-id must be a uuid");

function envFile(name) {
  const file = [path.join(ROOT, name), path.join(ROOT, "..", "..", name)].find((candidate) => existsSync(candidate));
  if (!file) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.includes("=") && !line.trim().startsWith("#")).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
  }));
}
const file = envFile(".env.owner.local");
const get = (key) => process.env[key] ?? file[key];
const [url, anon, email, password] = ["OWNER_SUPABASE_URL", "OWNER_SUPABASE_ANON_KEY", "OWNER_SUPABASE_EMAIL", "OWNER_SUPABASE_PASSWORD"].map(get);
if (!url || !anon || !email || !password) fail("OWNER_SUPABASE_URL / _ANON_KEY / _EMAIL / _PASSWORD not found (environment or .env.owner.local)");

const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
const signedIn = await sb.auth.signInWithPassword({ email, password });
if (signedIn.error) fail(`owner sign-in failed (${signedIn.error.status ?? "?"})`);
const owner = await sb.rpc("is_product_lab_owner");
if (owner.error || owner.data !== true) fail("the signed-in session is not the product lab owner");

const COLUMNS = "id,status,payment_status,payment_method,paid_at,paid_amount,refunded_at,completed_at,cancelled_at,placed_at,updated_at,fulfillment_method,customer_id";
const count = async (table, filter) => {
  let query = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) query = filter(query);
  const result = await query;
  if (result.error) fail(`could not count ${table} (${result.error.code})`);
  return result.count;
};

async function snapshot() {
  const order = await sb.from("orders").select(COLUMNS).eq("id", orderId).maybeSingle();
  if (order.error) fail(`could not read the order (${order.error.code})`);
  if (!order.data) fail("no such order");
  const lines = await sb.from("order_lines").select("id,product_id,quantity,unit_price,pieces_per_unit_snapshot").eq("order_id", orderId).order("id");
  const allocations = await sb.from("order_stock_allocations").select("id,status,reserved_pieces,production_execution_id,updated_at").eq("order_id", orderId).order("id");
  const cogs = await sb.from("order_raw_cogs").select("fulfilled_pieces,raw_production_cogs").eq("order_id", orderId);
  if (lines.error || allocations.error || cogs.error) fail("could not read the order's lines, allocations or COGS");
  return {
    order: order.data,
    lines: lines.data,
    allocations: allocations.data,
    cogs: cogs.data,
    counts: {
      orders: await count("orders"), order_lines: await count("order_lines"), order_stock_allocations: await count("order_stock_allocations"),
      finished_stock_movements: await count("finished_stock_movements"), inventory_transactions: await count("inventory_transactions"),
      production_executions: await count("production_executions"), order_raw_cogs: await count("order_raw_cogs"),
    },
  };
}
const stable = (snap) => JSON.stringify({ lines: snap.lines, allocations: snap.allocations, cogs: snap.cogs, counts: snap.counts });

const before = await snapshot();
const audit = await sb.from("order_refund_corrections").select("order_id,operation_id,reason,corrected_at").eq("order_id", orderId);
const migrationPresent = !audit.error;
console.log("BEFORE");
console.log("  order      ", JSON.stringify({ ...before.order, customer_id: "<hidden>" }));
console.log("  lines      ", JSON.stringify(before.lines));
console.log("  allocations", JSON.stringify(before.allocations));
console.log("  order COGS ", JSON.stringify(before.cogs));
console.log("  counts     ", JSON.stringify(before.counts));
console.log("  migration  ", migrationPresent ? `applied (audit rows for this order: ${audit.data.length})` : `NOT applied (${audit.error.code})`);
if (migrationPresent && audit.data.some((row) => row.operation_id === operationId)) {
  // A retry after a lost response: the function already ran under THIS operation id. Do not call it again.
  console.log("ALREADY APPLIED under this operation id (corrected_at " + audit.data[0].corrected_at + "). Nothing was sent. Order is " + before.order.payment_status + "; verify with the BEFORE block above.");
  await sb.auth.signOut();
  process.exit(0);
}
console.log("WOULD SEND  correct_mistaken_refund", JSON.stringify({ p_operation_id: operationId, p_order_id: orderId, p_reason: reason.trim(), p_expected_refunded_at: refundedAt, p_expected_paid_amount: amount }));

const problems = [];
if (before.order.payment_status !== "refunded") problems.push(`the order is "${before.order.payment_status}", not refunded`);
if (before.order.status === "cancelled") problems.push("the order is cancelled; the database refuses to undo a refund on a cancelled order");
if (before.order.refunded_at && Math.abs(Date.parse(before.order.refunded_at) - Date.parse(refundedAt)) >= 1) problems.push(`--refunded-at does not match the stored value ${before.order.refunded_at}`);
if (Number(before.order.paid_amount) !== amount) problems.push(`--amount does not match the stored paid_amount ${before.order.paid_amount}`);
if (before.order.refunded_at && Date.now() - Date.parse(before.order.refunded_at) > 7 * 24 * 60 * 60 * 1000) problems.push("the refund is older than 7 days; the database will refuse it");
if (!migrationPresent) problems.push("the refund-correction migration is not applied to this database");
if (migrationPresent && audit.data.length > 0) problems.push("this order has already been corrected once; the database will refuse a second correction");
for (const problem of problems) console.log(`  BLOCKER: ${problem}`);

if (!apply) {
  console.log(problems.length ? "\nDRY RUN: not eligible as things stand (see BLOCKER lines). Nothing was written." : "\nDRY RUN: eligible. Nothing was written. Re-run with --apply (and the same --operation-id) to make the correction.");
  await sb.auth.signOut();
  process.exit(0);
}
if (problems.length) { await sb.auth.signOut(); fail("refusing to call the function while a BLOCKER is present"); }

const result = await sb.rpc("correct_mistaken_refund", { p_operation_id: operationId, p_order_id: orderId, p_reason: reason.trim(), p_expected_refunded_at: refundedAt, p_expected_paid_amount: amount });
if (result.error) { await sb.auth.signOut(); fail(`the database refused the correction: ${result.error.code} ${result.error.message}`); }
console.log("\nCALL RETURNED", JSON.stringify({ id: result.data?.id, payment_status: result.data?.payment_status, refunded_at: result.data?.refunded_at, updated_at: result.data?.updated_at }));

const after = await snapshot();
const auditAfter = await sb.from("order_refund_corrections").select("order_id,reason,corrected_at,original_payment_status,original_paid_amount,original_refunded_at,original_paid_at,original_order_updated_at").eq("order_id", orderId);
console.log("AFTER");
console.log("  order      ", JSON.stringify({ ...after.order, customer_id: "<hidden>" }));
console.log("  counts     ", JSON.stringify(after.counts));
console.log("  audit row  ", JSON.stringify(auditAfter.data));

const checks = [];
const changed = Object.keys(before.order).filter((key) => JSON.stringify(before.order[key]) !== JSON.stringify(after.order[key])).sort();
checks.push(["only payment_status, refunded_at and updated_at changed on the order", JSON.stringify(changed) === JSON.stringify(["payment_status", "refunded_at", "updated_at"].sort()), changed.join(",")]);
checks.push(["order is now paid with no refund", after.order.payment_status === "paid" && after.order.refunded_at === null, ""]);
checks.push(["paid_at, paid_amount, method and completion are exactly as before", ["paid_at", "paid_amount", "payment_method", "status", "completed_at"].every((key) => before.order[key] === after.order[key]), ""]);
checks.push(["lines, stock allocations, order COGS and every global count are unchanged", stable(before) === stable(after), ""]);
checks.push(["exactly one audit row exists with the original refund preserved", auditAfter.data?.length === 1 && auditAfter.data[0].original_payment_status === "refunded" && Number(auditAfter.data[0].original_paid_amount) === amount && Date.parse(auditAfter.data[0].original_refunded_at) === Date.parse(before.order.refunded_at) && auditAfter.data[0].reason === reason.trim(), ""]);
let bad = 0;
console.log("\nVERIFICATION");
for (const [name, ok, detail] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) bad += 1; }
await sb.auth.signOut();
if (bad) fail(`${bad} verification check(s) failed. Do NOT retry blindly; investigate.`);
console.log("\nCorrection applied and verified.");
