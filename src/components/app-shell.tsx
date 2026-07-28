import { ArrowRight } from "lucide-react";
import { HeaderBadge } from "@/components/ui";
import { navItems, type LabView } from "@/lib/lab-state";

const titles = {
  dashboard: "Product proof command center",
  products: "Products and launch readiness",
  "product-detail": "Product detail",
  "proof-day": "Proof day mode",
  batches: "Product proof batches",
  costing: "Costing and pricing",
  equipment: "Equipment and depreciation",
  inventory: "Inventory",
  bake: "Bake and deduct inventory",
  journal: "Journey",
  admin: "Product admin",
  launch: "Launch offer builder",
  "content-studio": "Content studio",
  guide: "How to use Product Lab",
};

export function AppShell({ children, view }: { children: React.ReactNode; view: LabView }) {
  return (
    <main className="min-h-screen bg-[#f7f2ea] text-[#211713]">
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-[#e1d4c4] bg-[#231813] p-5 text-[#fff8ef] lg:block">
        <div className="mb-8 border-b border-white/10 pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#ddb778]">Aly & Shin</p>
          <h1 className="mt-2 text-2xl font-semibold">Product Lab</h1>
          <p className="mt-2 text-sm leading-6 text-[#d8c6b8]">Internal system for proving products before launch.</p>
        </div>
        <nav className="space-y-1">
          {navItems.map((item) => (
            <a
              className={`flex items-center justify-between rounded-md px-3 py-2.5 text-sm hover:bg-white/10 ${
                item.view === view ? "bg-white/10 text-white" : "text-[#f5e7d8]"
              }`}
              href={item.href}
              key={item.href}
            >
              {item.label}
              <ArrowRight size={14} />
            </a>
          ))}
        </nav>
        <div className="absolute bottom-5 left-5 right-5 rounded-md border border-white/15 bg-white/5 p-4 text-sm text-[#ead9c8]">
          <p className="font-semibold text-white">Today&apos;s rule</p>
          <p className="mt-2 leading-6">No launch menu decisions until taste, cost, freshness, and packaging have proof.</p>
        </div>
      </aside>

      <section className="lg:pl-72">
        <AppHeader view={view} />
        <nav className="flex gap-2 overflow-x-auto border-b border-[#e1d4c4] bg-white px-4 py-3 lg:hidden">
          {navItems.map((item) => (
            <a
              className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium ${
                item.view === view ? "bg-[#231813] text-white" : "bg-[#fffaf3] text-[#5f4a3d]"
              }`}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </a>
          ))}
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
          <HeaderBadge label="Stage" value="Pre-launch" />
          <HeaderBadge label="Model" value="Home preorder" />
          <HeaderBadge label="Focus" value="Bakery first" />
        </div>
      </div>
    </header>
  );
}
