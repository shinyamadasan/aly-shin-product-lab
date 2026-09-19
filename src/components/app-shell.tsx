import { ArrowRight } from "lucide-react";
import { HeaderBadge } from "@/components/ui";
import { navGroups, navItems, type LabView } from "@/lib/lab-state";

const titles = {
  // Empty by design -- the frozen Today wireframe spec calls for no page-title chrome beyond the
  // app's own permanent header ("Product Lab" in the sidebar above), so this view's subtitle line
  // renders nothing rather than a title competing with the recommendation itself.
  today: "",
  dashboard: "Dashboard",
  products: "Products and launch readiness",
  "product-detail": "Product detail",
  "proof-day": "Proof day mode",
  batches: "Product proof batches",
  costing: "Costing and pricing",
  orders: "Orders",
  equipment: "Equipment and depreciation",
  inventory: "Inventory",
  bake: "Bake and deduct inventory",
  journal: "Journey",
  opportunities: "Opportunity review",
  admin: "Product admin",
  launch: "Launch offer builder",
  brand: "Brand Foundation",
  "content-studio": "Content studio",
  guide: "How to use Product Lab",
  // Reachable at /context by URL only -- deliberately not in navItems (see LabView in lab-state.ts).
  context: "Business context",
};

// shouldConfirmNavigation/navigationConfirmationMessage are deliberately generic, not named after
// any one form: today only Costing feeds them (via ProductLab), but any future form with the same
// "unsaved changes" risk can reuse this exact contract without AppShell needing to know which form
// it is. Plain anchors, not next/link -- this app's internal nav is real browser navigation (see
// costing-form-snapshot.ts's callers), so onClick + preventDefault is what actually intercepts a
// click here, and letting a confirmed click fall through to the anchor's own default behavior
// preserves that real navigation exactly as it already works, unchanged.
//
// onSignOut lives here because sign-out used to sit on the old Dashboard only; the shell is the one
// piece present on every page. Optional so the shell still renders without an auth session.
export function AppShell({
  children,
  navigationConfirmationMessage,
  onSignOut,
  shouldConfirmNavigation,
  view,
}: {
  children: React.ReactNode;
  navigationConfirmationMessage?: string;
  onSignOut?: () => void;
  shouldConfirmNavigation?: boolean;
  view: LabView;
}) {
  function handleNavClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (shouldConfirmNavigation && !window.confirm(navigationConfirmationMessage ?? "You have unsaved changes. Leaving now will discard them. Continue?")) {
      event.preventDefault();
    }
  }

  const itemsByGroup = navGroups.map((group) => ({ ...group, items: navItems.filter((item) => item.group === group.id) }));
  const primaryGroups = itemsByGroup.filter((group) => group.id !== "more");
  const moreGroup = itemsByGroup.find((group) => group.id === "more");
  const isMoreActive = Boolean(moreGroup?.items.some((item) => item.view === view));

  return (
    <main className="min-h-screen bg-[#f7f2ea] text-[#211713]">
      <aside className="fixed inset-y-0 left-0 hidden w-72 flex-col border-r border-[#e1d4c4] bg-[#231813] p-5 text-[#fff8ef] lg:flex">
        <div className="mb-6 border-b border-white/10 pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#ddb778]">Aly & Shin</p>
          <h1 className="mt-2 text-2xl font-semibold">Product Lab</h1>
          <p className="mt-2 text-sm leading-6 text-[#d8c6b8]">Run orders, stock, production, products, and growth from one workspace.</p>
        </div>
        <nav aria-label="Main" className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          {itemsByGroup.map((group) => {
            const isQuiet = group.id === "more";
            return (
              <div key={group.id}>
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#ddb778]/80">{group.label}</p>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <a
                      aria-current={item.view === view ? "page" : undefined}
                      className={`flex items-center justify-between rounded-md px-3 hover:bg-white/10 ${isQuiet ? "py-1.5 text-[13px]" : "py-2.5 text-sm"} ${
                        item.view === view ? "bg-white/10 text-white" : isQuiet ? "text-[#d8c6b8]" : "text-[#f5e7d8]"
                      }`}
                      href={item.href}
                      key={item.href}
                      onClick={handleNavClick}
                    >
                      {item.label}
                      <ArrowRight size={14} />
                    </a>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        {onSignOut ? (
          <div className="mt-4 border-t border-white/10 pt-4">
            <button className="text-sm text-[#ddb778] underline" onClick={onSignOut} type="button">Sign out</button>
          </div>
        ) : null}
      </aside>

      <section className="lg:pl-72">
        <AppHeader view={view} />
        <nav aria-label="Main" className="border-b border-[#e1d4c4] bg-white px-4 py-3 lg:hidden">
          <div className="flex gap-2 overflow-x-auto">
            {primaryGroups.map((group) => (
              <div className="flex shrink-0 items-center gap-2" key={group.id}>
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#9a5b2f]">{group.label}</span>
                {group.items.map((item) => (
                  <a
                    aria-current={item.view === view ? "page" : undefined}
                    className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium ${
                      item.view === view ? "bg-[#231813] text-white" : "bg-[#fffaf3] text-[#5f4a3d]"
                    }`}
                    href={item.href}
                    key={item.href}
                    onClick={handleNavClick}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            ))}
          </div>
          {moreGroup ? (
            // A native disclosure, not a drawer: nothing to build or keep in sync, and every page in
            // it stays one tap away. Open by default when the current page lives here, so the active
            // item is never hidden from the person standing on it.
            <details className="mt-2" open={isMoreActive}>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.14em] text-[#9a5b2f]">{moreGroup.label}</summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {moreGroup.items.map((item) => (
                  <a
                    aria-current={item.view === view ? "page" : undefined}
                    className={`rounded-md px-3 py-2 text-sm font-medium ${
                      item.view === view ? "bg-[#231813] text-white" : "bg-[#fffaf3] text-[#5f4a3d]"
                    }`}
                    href={item.href}
                    key={item.href}
                    onClick={handleNavClick}
                  >
                    {item.label}
                  </a>
                ))}
                {onSignOut ? (
                  <button className="rounded-md px-3 py-2 text-sm font-medium text-[#8f5632] underline" onClick={onSignOut} type="button">Sign out</button>
                ) : null}
              </div>
            </details>
          ) : null}
        </nav>
        <div className="space-y-6 px-4 py-5 sm:px-6 xl:px-8">{children}</div>
      </section>
    </main>
  );
}

function AppHeader({ view }: { view: LabView }) {
  return (
    <header className="border-b border-[#e1d4c4] bg-[#fffaf3] px-4 py-4 sm:px-6 xl:px-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b2f]">Private workspace</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{titles[view]}</h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <HeaderBadge label="Stage" value="Selling" />
          <HeaderBadge label="Model" value="Home-based preorder" />
          <HeaderBadge label="Focus" value="Bakery operations" />
        </div>
      </div>
    </header>
  );
}
