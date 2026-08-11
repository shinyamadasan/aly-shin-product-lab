// Runtime v1 (PR-3): the /context surface.
//
// Source-level architectural assertions, which is this repo's established idiom for UI wiring
// (tests/today-page.test.ts does the same). It is not a stylistic preference: `node --test` strips
// TypeScript but does not transform JSX, so a .tsx component cannot be imported here at all. What
// that buys is still the part worth protecting -- the wiring and the boundaries -- and the rendered
// behaviour is covered by the manual state checks recorded with this slice.
//
// The load-bearing assertion in this file is the gate: the session check must precede the read.
// Without it an unauthenticated visit would return RLS-filtered empty rows that the readers, doing
// exactly what they are designed to do, would report as a successful empty business.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROUTE = readFileSync(new URL("../src/app/context/page.tsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../src/components/business-context-page.tsx", import.meta.url), "utf8");
const LAB_STATE = readFileSync(new URL("../src/lib/lab-state.ts", import.meta.url), "utf8");
const APP_SHELL = readFileSync(new URL("../src/components/app-shell.tsx", import.meta.url), "utf8");

// Scans below are about CODE. Both new files document in prose the very things the scans forbid
// ("no localStorage read", "never call insert"), so scanning raw text would assert the opposite.
function withoutComments(source: string): string {
  return source.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const ROUTE_CODE = withoutComments(ROUTE);
const PAGE_CODE = withoutComments(PAGE);

// --- Route wiring -------------------------------------------------------------------------------

test("[PR-3] /context is a standalone route that renders the Business Context component", () => {
  assert.ok(ROUTE_CODE.includes("BusinessContextPage"));
  assert.ok(/export default function \w+\(\)/.test(ROUTE_CODE));
  // The whole point of the slice: this surface does not go through the monolith or LabState.
  assert.equal(ROUTE_CODE.includes("ProductLab"), false, "/context must not route through ProductLab");
  assert.equal(ROUTE_CODE.includes("product-lab"), false);
});

test("[PR-3] the component renders inside AppShell under the context view", () => {
  assert.ok(PAGE_CODE.includes('<AppShell view="context">'));
  assert.ok(PAGE_CODE.includes('from "@/components/app-shell"'));
  // app-shell.tsx carries onClick handlers and has no "use client" of its own, so it is only valid
  // inside the client boundary -- which is why the client component renders it, not the route.
  assert.ok(PAGE.startsWith('"use client";'));
});

test("[PR-3] the context view is registered in LabView and titled in AppShell", () => {
  assert.ok(/\|\s*"context";/.test(LAB_STATE), "LabView must include the context view");
  assert.ok(/context:\s*"Business context"/.test(APP_SHELL), "AppShell must title the context view");
});

test("[PR-2] Business Context is discoverable from the normal navigation", () => {
  const navItems = LAB_STATE.slice(LAB_STATE.indexOf("export const navItems"), LAB_STATE.indexOf("export const storageKey"));

  // Unlisted through Runtime v1 while it was unproven; listed now that live validation settled it.
  // One entry added using the existing convention -- no new hierarchy, no badge, no count.
  assert.ok(navItems.includes('{ label: "Business Context", href: "/context", view: "context" }'));
  assert.equal((navItems.match(/href: "/g) ?? []).length, 18, "exactly one nav entry added");
  assert.equal(navItems.includes("badge"), false);
  assert.equal(navItems.includes("count"), false);
});

// --- Auth, and the gate --------------------------------------------------------------------------

test("[PR-3] the page reuses the existing browser client and session lifecycle", () => {
  assert.ok(PAGE_CODE.includes('from "@/lib/supabase"'));
  assert.ok(PAGE_CODE.includes("isSupabaseConfigured"));
  assert.ok(PAGE_CODE.includes("supabase.auth.getSession()"));
  assert.ok(PAGE_CODE.includes("supabase.auth.onAuthStateChange"));
  // No new auth system, and no duplicated sign-in form: the app already owns sign-in.
  assert.equal(PAGE_CODE.includes("signInWithPassword"), false);
  assert.equal(PAGE_CODE.includes("LoginScreen"), false);
  assert.equal(PAGE_CODE.includes("signOut"), false);
});

test("[PR-3] no server-only, service-role or website-user credential path is reachable", () => {
  for (const forbidden of ["supabase-server", "server-only", "SERVICE_ROLE", "service_role", "PUBLIC_ORDER_SUPABASE", "getPublicOrderClient", "withPublicOrderClient"]) {
    assert.equal(PAGE_CODE.includes(forbidden), false, `the page must not reference ${forbidden}`);
    assert.equal(ROUTE_CODE.includes(forbidden), false);
  }
});

test("[PR-3] the configured-and-signed-in gate precedes the runtime read", () => {
  const guard = PAGE_CODE.indexOf("if (!isSupabaseConfigured || !supabase || !sessionUserId)");
  const read = PAGE_CODE.indexOf("buildCurrentBusinessContext({");

  assert.ok(guard > -1, "the gate must exist as a single explicit condition");
  assert.ok(read > -1);
  assert.ok(guard < read, "the gate must be decided BEFORE any read is issued");

  // And the guard returns rather than falling through.
  const between = PAGE_CODE.slice(guard, read);
  assert.ok(between.includes("return;"));
});

test("[PR-3] an unconfigured project renders the approved no-build state", () => {
  assert.ok(PAGE_CODE.includes("Business Context needs a live Supabase connection. This page does not read the localStorage fallback."));
  assert.ok(/if \(!isSupabaseConfigured\) \{/.test(PAGE_CODE));
  // No fallback path exists to fabricate a context from. localStorage is checked as an API call
  // rather than as a word, because the approved copy above legitimately names it.
  for (const fallback of ["storageKey", "emptyState", "LabState", "labState", "window.localStorage", "localStorage.getItem", "localStorage.setItem"]) {
    assert.equal(PAGE_CODE.includes(fallback), false, `the page must not reference ${fallback}`);
  }
});

test("[PR-3] a signed-out visitor gets the approved state and no build", () => {
  assert.ok(PAGE_CODE.includes("Sign in to generate a snapshot."));
  assert.ok(/if \(!sessionUserId\) \{/.test(PAGE_CODE));
});

test("[PR-3] auth loading is distinguishable from signed out", () => {
  assert.ok(PAGE_CODE.includes("Checking session…"));
  assert.ok(PAGE_CODE.includes("Sign in to generate a snapshot."));
  assert.ok(PAGE_CODE.includes("isAuthLoading"));
  // Two different states, two different messages -- "we do not know yet" is not "you are signed out".
  assert.notEqual(PAGE_CODE.indexOf("Checking session…"), PAGE_CODE.indexOf("Sign in to generate a snapshot."));
});

test("[PR-3] a build in flight renders a truthful loading state, not an empty snapshot", () => {
  assert.ok(PAGE_CODE.includes("Reading live data…"));
  assert.ok(/if \(isBuilding\) \{/.test(PAGE_CODE));
  // No zeroed placeholder metrics and no skeleton context.
  assert.equal(PAGE_CODE.includes("skeleton"), false);
});

// --- One clock, one build -------------------------------------------------------------------------

test("[PR-3] exactly one clock reading supplies nowMs for a build", () => {
  const clocks = PAGE_CODE.match(/Date\.now\(\)/g) ?? [];

  assert.equal(clocks.length, 1, "the page boundary captures now exactly once per build");
  assert.ok(PAGE_CODE.includes("const nowMs = Date.now();"));
  assert.ok(/buildCurrentBusinessContext\(\{[\s\S]*?nowMs,/.test(PAGE_CODE));
  // Snapshot semantics come from the completed context, never recomputed in the UI.
  assert.equal(PAGE_CODE.includes("resolveBusinessDay"), false);
  assert.equal(PAGE_CODE.includes("BUSINESS_TIMEZONE"), false);
  assert.equal(PAGE_CODE.includes("toLocaleString"), false);
});

test("[PR-3] displayed metadata is read from the built context", () => {
  for (const field of ["context.generatedAt", "context.businessDay", "context.timezone", "context.dataSource", "context.contextSchemaVersion", "context.factsDigest", "context.signalsDigest"]) {
    assert.ok(PAGE_CODE.includes(field), `${field} must come from the context`);
  }
});

test("[PR-3] the page calls the runtime and the brief renderer, each once", () => {
  assert.ok(PAGE_CODE.includes('from "@/lib/business-context/runtime"'));
  assert.ok(PAGE_CODE.includes('from "@/lib/business-context/brief"'));
  assert.equal((PAGE_CODE.match(/buildCurrentBusinessContext\(/g) ?? []).length, 1);
  // Rendered once, at build time, and stored. Copy hands over those exact bytes rather than
  // re-rendering, so what was read on screen is what gets pasted.
  assert.equal((PAGE_CODE.match(/renderBusinessBrief\(/g) ?? []).length, 1);
  assert.equal((PAGE_CODE.match(/renderCompactBrief\(/g) ?? []).length, 1);
});

test("[PR-3] Refresh rebuilds and is disabled while a build is in flight", () => {
  assert.ok(PAGE_CODE.includes("disabled={isBuilding}"));
  assert.ok(PAGE_CODE.includes("onClick={refresh}"));
  assert.ok(PAGE_CODE.includes("setReloadToken((token) => token + 1)"));
  assert.ok(/\}, \[sessionUserId, reloadToken\]\)/.test(PAGE_CODE), "the build effect must re-run on the reload token");
  // A response from a superseded build is discarded rather than overwriting a fresher snapshot.
  assert.ok(PAGE_CODE.includes("let cancelled = false;"));
  assert.ok(PAGE_CODE.includes("if (cancelled) return;"));
  // No polling, no interval, no automatic refresh.
  for (const timer of ["setInterval", "setTimeout", "requestAnimationFrame"]) {
    assert.equal(PAGE_CODE.includes(timer), false, `the page must not use ${timer}`);
  }
});

// --- Failure behaviour ------------------------------------------------------------------------------

test("[PR-3] a thrown runtime error surfaces, and never fabricates a context", () => {
  assert.ok(PAGE_CODE.includes("catch (error)"));
  assert.ok(PAGE_CODE.includes("setLoadError("));
  assert.ok(PAGE_CODE.includes("Could not build the business context:"));
  // The message is retained for debugging rather than replaced by a generic string.
  assert.ok(PAGE_CODE.includes("error instanceof Error ? error.message : String(error)"));
  assert.ok(PAGE_CODE.includes("ownedError.message"), "the surfaced error must be the one owned by the current identity");
  // The failure path offers a retry.
  const errorBranch = PAGE_CODE.slice(PAGE_CODE.indexOf("if (ownedError)"));
  assert.ok(errorBranch.slice(0, 400).includes("Refresh"));
});

test("[PR-3] the snapshot is discarded only on a thrown exception or sign-out, so partial reads still render", () => {
  const discards = PAGE_CODE.match(/setSnapshot\(null\)/g) ?? [];
  assert.equal(discards.length, 2, "a snapshot is dropped in exactly two places");

  // One: the signed-out transition, inside the auth callback.
  const authCallback = PAGE_CODE.slice(PAGE_CODE.indexOf("onAuthStateChange"), PAGE_CODE.indexOf("return () => data.subscription.unsubscribe();"));
  assert.ok(authCallback.includes("if (!nextSession)"));
  assert.ok(authCallback.includes("setSnapshot(null)"));

  // Two: the catch block -- never a coverage check. A context whose domains failed is a success
  // path: build.ts already degraded them and the brief already explains what is unavailable.
  const catchStart = PAGE_CODE.indexOf("catch (error)");
  const finallyStart = PAGE_CODE.indexOf("} finally {");
  const inCatch = PAGE_CODE.slice(catchStart, finallyStart);
  assert.ok(inCatch.includes("setSnapshot(null)"));
});

// --- Auth-transition ownership ----------------------------------------------------------------------
//
// A previous operator's Business Context must never be presented as the current one's, even for the
// moment between an identity change and the new build landing.

test("[PR-3] a snapshot is stamped with the identity that authorized its build", () => {
  assert.ok(/userId: string;/.test(PAGE_CODE), "Snapshot carries the owning user id");
  assert.ok(PAGE_CODE.includes("const sessionUserId = session?.user.id ?? null;"));
  assert.ok(PAGE_CODE.includes("userId: sessionUserId"), "the build stamps the snapshot with the current identity");
});

test("[PR-3] a snapshot owned by a different identity cannot render", () => {
  assert.ok(PAGE_CODE.includes("snapshot && snapshot.userId === sessionUserId ? snapshot : null"));
  assert.ok(PAGE_CODE.includes("renderSnapshot(ownedSnapshot)"), "only the owned snapshot is ever rendered");
  // The unowned case falls through to the truthful loading state rather than to stale data.
  const ownership = PAGE_CODE.slice(PAGE_CODE.indexOf("const ownedError"));
  assert.ok(/if \(!ownedSnapshot\) \{\s*return <MessageBox message=\{READING\}/.test(ownership));
});

test("[PR-3] an error is owned too, so one identity's failure is not shown to the next", () => {
  assert.ok(PAGE_CODE.includes("loadError && loadError.userId === sessionUserId ? loadError : null"));
  assert.ok(PAGE_CODE.includes("userId: sessionUserId }"), "a failed build records whose build failed");
});

test("[PR-3] signing out clears the retained snapshot and stale load/copy state", () => {
  const authCallback = PAGE_CODE.slice(PAGE_CODE.indexOf("onAuthStateChange"), PAGE_CODE.indexOf("return () => data.subscription.unsubscribe();"));

  assert.ok(authCallback.includes("if (!nextSession)"));
  assert.ok(authCallback.includes("setSnapshot(null)"));
  assert.ok(authCallback.includes("setLoadError(null)"));
  assert.ok(authCallback.includes("setCopyNotice(null)"));
});

test("[PR-3] the build effect is keyed to authenticated identity, not Session object identity", () => {
  // Keying on the user id means a routine token refresh -- a new Session object for the SAME
  // operator -- neither discards a valid snapshot nor triggers a pointless rebuild, while an actual
  // change of operator does both.
  assert.ok(/\}, \[sessionUserId, reloadToken\]\)/.test(PAGE_CODE));
  assert.equal(/\}, \[session, reloadToken\]\)/.test(PAGE_CODE), false, "the effect must not depend on the Session object");

  // The build body reads the identity, not the session object.
  const effect = PAGE_CODE.slice(PAGE_CODE.indexOf("async function buildSnapshot"), PAGE_CODE.indexOf("}, [sessionUserId, reloadToken])"));
  assert.equal(/[^U]\bsession\b(?!UserId)/.test(effect), false, "the build must not reference the raw session object");
});

test("[PR-3] ownership is UI state only and never reaches the brief, JSON, clipboard or metadata", () => {
  // renderSnapshot destructures context and brief only, so the owning id has no path to the screen.
  assert.ok(PAGE_CODE.includes("function renderSnapshot({ context, compact, brief }: Snapshot)"));
  // The copied bytes and the raw JSON are the canonical artefacts, unchanged by ownership.
  assert.ok(PAGE_CODE.includes('copyText(compact, "Business context")'));
  assert.ok(PAGE_CODE.includes('copyText(JSON.stringify(context, null, 2), "Raw JSON")'));
  // No metadata row exposes it, and it is never written anywhere.
  assert.equal(PAGE_CODE.includes("label=\"User\""), false);
  assert.equal(/Metadata[^\n]*userId/.test(PAGE_CODE), false);
  for (const persist of ["localStorage.setItem", "sessionStorage", "document.cookie"]) {
    assert.equal(PAGE_CODE.includes(persist), false, `ownership must not be persisted via ${persist}`);
  }
});

test("[PR-3] the all-domains-failed warning is derived from DomainContexts, not coverage counts", () => {
  assert.ok(PAGE_CODE.includes("hasNoReadableDomain"));
  assert.ok(PAGE_CODE.includes("Object.values(context.domains)"));
  assert.ok(PAGE_CODE.includes("readOutcome.ok"));
  assert.ok(PAGE_CODE.includes("No domain could be read on this run."));

  // PR-2 separated "unbuilt" from "unreadable"; the page must not flatten it again by counting
  // coverage entries or hard-coding today's eleven-unbuilt / fifteen-declared numbers.
  assert.equal(/coverage\.absent\.length/.test(PAGE_CODE), false);
  assert.equal(/coverage\.knownDomains\.length/.test(PAGE_CODE), false);
  assert.equal(/===\s*15\b/.test(PAGE_CODE), false);
  assert.equal(/===\s*11\b/.test(PAGE_CODE), false);
});

// --- Copy -------------------------------------------------------------------------------------------

test("[PR-2] Copy Context writes exactly the rendered COMPACT brief, with nothing added", () => {
  assert.ok(PAGE_CODE.includes("navigator.clipboard.writeText"));
  assert.ok(PAGE_CODE.includes('copyText(compact, "Business context")'), "Copy Context copies the stored compact brief");
  // Full fidelity stays available under its own action.
  assert.ok(PAGE_CODE.includes('copyText(brief, "Full brief")'));

  // No wrapper prompt, no instruction, no fence, no hidden context around the copied bytes.
  for (const wrapper of ["```", "You are", "Given this", "Please analyse", "Please analyze", "prompt"]) {
    assert.equal(PAGE_CODE.includes(wrapper), false, `the copied payload must not add ${wrapper}`);
  }
});

test("[PR-3] Copy JSON is a separate debugging action over the canonical context", () => {
  assert.ok(PAGE_CODE.includes('copyText(JSON.stringify(context, null, 2), "Raw JSON")'));
  assert.ok(PAGE_CODE.includes(">Copy JSON<"));
  assert.ok(PAGE_CODE.includes(">Copy Context<"));
  // Two distinct actions: the AI-paste workflow is the brief, never the JSON.
  assert.notEqual(PAGE_CODE.indexOf(">Copy JSON<"), PAGE_CODE.indexOf(">Copy Context<"));
});

test("[PR-3] copy reports success and failure visibly", () => {
  assert.ok(PAGE_CODE.includes("copied to the clipboard."));
  assert.ok(PAGE_CODE.includes("Could not copy"));
  assert.ok(PAGE_CODE.includes("copyNotice"));
});

test("[PR-3] raw JSON is collapsed by default and is the canonical context", () => {
  assert.ok(PAGE_CODE.includes("<details"));
  assert.ok(PAGE_CODE.includes("Raw BusinessContext JSON"));
  // Collapsed: no `open` attribute on the details element.
  const details = PAGE_CODE.slice(PAGE_CODE.indexOf("<details"), PAGE_CODE.indexOf("</details>"));
  assert.equal(/<details[^>]*\sopen/.test(details), false, "raw JSON must not render expanded");
  // Not persisted, not downloaded.
  for (const escape of ["createObjectURL", "download", "localStorage.setItem", "sessionStorage"]) {
    assert.equal(PAGE_CODE.includes(escape), false, `raw JSON must not be ${escape}`);
  }
});

// --- Boundaries --------------------------------------------------------------------------------------

test("[PR-3] the page adds no business write of any kind", () => {
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", ".storage", "save_order"]) {
    assert.equal(PAGE_CODE.includes(write), false, `the page must not call ${write}`);
  }
  // Only these Supabase surfaces are touched at all.
  const supabaseCalls = [...PAGE_CODE.matchAll(/supabase\.([a-zA-Z.]+)/g)].map((match) => match[1]);
  for (const call of supabaseCalls) {
    assert.ok(call.startsWith("auth."), `unexpected supabase surface: supabase.${call}`);
  }
});

test("[PR-3] the page performs no enrichment beyond the canonical envelope", () => {
  for (const forbidden of ["product-lab", "supabase-mappers", "orders-repository", "@/lib/orders", "inventory-status", "inventory-cost", "costing", "brand_profiles", "customers", "productName", "products["]) {
    assert.equal(PAGE_CODE.includes(forbidden), false, `the page must not reference ${forbidden}`);
  }
});

test("[PR-3] the page introduces no truncation, summarization, ranking or view budget", () => {
  for (const forbidden of ["ContextView", "truncate", "slice(0,", "summarize", "summarise", "orderingId", "topN", "limit("]) {
    assert.equal(PAGE_CODE.includes(forbidden), false, `the page must not contain ${forbidden}`);
  }
  assert.equal(/\.sort\s*\(/.test(PAGE_CODE), false, "the page must not rank anything");
});

test("[PR-3] business-context modules stay free of server-only and node builtins", () => {
  // The runtime and brief are pulled into a client bundle by this page for the first time, so the
  // browser-safety property M1 designed for is now load-bearing rather than theoretical.
  const modules = ["runtime.ts", "brief.ts", "build.ts", "types.ts", "registry.ts", "digest.ts", "selectors.ts", "readers/supabase.ts"];
  for (const name of modules) {
    const source = readFileSync(new URL(`../src/lib/business-context/${name}`, import.meta.url), "utf8");
    const code = withoutComments(source);
    assert.equal(code.includes("server-only"), false, `${name} must not import server-only`);
    assert.equal(/from\s+"node:/.test(code), false, `${name} must not import a node builtin`);
  }
});

// --- PR-2: compact primary, full fidelity retained ---------------------------------------------------

test("[PR-2] the compact brief is the primary readout and the full brief stays available", () => {
  assert.ok(PAGE_CODE.includes('title="Business brief (compact)"'), "the panel shows the compact brief");
  assert.ok(PAGE_CODE.includes("{compact}"), "compact is what renders in the primary panel");
  // Full fidelity is one click away, in its own collapsed section with its own copy action.
  assert.ok(PAGE_CODE.includes("Full brief (every published fact)"));
  assert.ok(PAGE_CODE.includes(">Copy Full Brief<"));
  assert.ok(PAGE_CODE.includes("{brief}"));
  // Raw canonical JSON is untouched and still copyable.
  assert.ok(PAGE_CODE.includes("Raw BusinessContext JSON"));
  assert.ok(PAGE_CODE.includes(">Copy JSON<"));
});

test("[PR-2] all three payloads are rendered once and stored, never re-rendered on copy", () => {
  // Copy hands over stored bytes, so what was read on screen is what gets pasted.
  assert.ok(PAGE_CODE.includes("compact: renderCompactBrief(context)"));
  assert.ok(PAGE_CODE.includes("brief: renderBusinessBrief(context)"));
  assert.equal((PAGE_CODE.match(/renderCompactBrief\(/g) ?? []).length, 1);
});

test("[PR-2] the page is still read-only", () => {
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "<form", "<input", "<textarea", "onSubmit"]) {
    assert.equal(PAGE_CODE.includes(write), false, `the page must not introduce ${write}`);
  }
});
