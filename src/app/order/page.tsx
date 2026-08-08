// S9 PR-F3: the public order page.
//
// A Server Component. It reads the catalog with the server-only website principal and hands the
// client form a menu that is already sanitized -- product name, format name, price, pieces, image
// and nothing else. No Supabase client, no credential and no catalog row ever reaches the browser.
//
// The menu is built by the SAME helper the submission path uses (getPublicMenu -> getSellableItems),
// so what a customer can see and what the server will accept cannot drift apart.

import type { Metadata } from "next";
import { PublicOrderForm } from "@/components/public-order-form";
import { getPublicMenu, type PublicMenuProduct } from "@/lib/orders/public-menu";
import { resolveAttribution } from "@/lib/orders/public-order-form-state";
import { loadPublicCatalog, type PublicCatalogClient } from "@/lib/public-catalog-repository";
import { withPublicOrderClient } from "@/lib/supabase-server";

// This page is customer-facing, so it does not inherit the internal app's title.
export const metadata: Metadata = {
  title: "Order · Aly & Pon",
  description: "Order freshly baked goods from Aly & Pon for pickup.",
};

// Prices and availability are read per request; a cached menu could offer something already sold
// out or at yesterday's price.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function Unavailable() {
  return (
    <section className="mx-auto w-full max-w-lg px-4 py-10">
      <div className="rounded-2xl border border-[#e1d4c4] bg-white p-6 text-center">
        <h1 className="text-xl font-semibold text-[#5f4a3d]">Ordering is unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">We can&rsquo;t load the menu right now. Please try again shortly, or message us directly.</p>
      </div>
    </section>
  );
}

export default async function PublicOrderPage({ searchParams }: { searchParams: Promise<{ source?: string | string[]; ref?: string | string[] }> }) {
  const { source, ref } = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  // The customer never sees or chooses these -- they come from the link they followed.
  const attribution = resolveAttribution(first(source), first(ref));

  // Read through the recovery wrapper, not a bare client. The website principal's session is
  // deliberately non-persistent with autoRefreshToken:false, so a warm serverless instance can be
  // holding one that has since expired; withPublicOrderClient re-authenticates ONCE and retries
  // ONCE. Retrying is safe here because loading the catalog is read-only -- it writes nothing and
  // has no side effect to repeat.
  const attempt = await withPublicOrderClient(
    (client) => loadPublicCatalog(client as unknown as PublicCatalogClient),
    (result) => !result.ok,
  );

  if (!attempt.ok || !attempt.result.ok) {
    // Recovery failed, or the read failed twice. The repository's message can name a table, so the
    // customer sees only the generic state.
    return <Unavailable />;
  }

  const { catalog } = attempt.result;
  const menu: PublicMenuProduct[] = getPublicMenu(catalog.products, catalog.batches, catalog.costings, catalog.sellingFormats);

  return (
    <main className="min-h-full bg-[#fffaf3]">
      <PublicOrderForm menu={menu} source={attribution.source} sourceRef={attribution.sourceRef} />
    </main>
  );
}
