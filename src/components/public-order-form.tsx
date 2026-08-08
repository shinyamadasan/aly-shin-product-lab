"use client";

// S9 PR-F3: the customer-facing order form.
//
// This is the only customer-facing surface in the app, and it is deliberately thin: it renders a
// menu the server already decided, collects four fields, and POSTs to /api/public-orders. It holds
// no Supabase client, no credential, and no authority over any commercial fact -- price, item name,
// pieces, ids, status, payment and entry method are all the server's, and are not even sent.
//
// All the logic worth being sure about lives in src/lib/orders/public-order-form-state.ts as pure
// functions, so the idempotency lifecycle and response handling are tested without a DOM.

import Image from "next/image";
import { useState } from "react";
import { toDisplayPrice } from "@/lib/orders/money";
import {
  applyResponse,
  applyTransportFailure,
  buildRequestBody,
  canSubmit,
  createInitialState,
  getOrderTotal,
  getSafePublicImage,
  getSelectedLines,
  getSubmitBlocker,
  markSubmitting,
  setContact,
  setQuantity,
  startNewOrder,
  type PublicOrderResponse,
} from "@/lib/orders/public-order-form-state";
import type { PublicMenuProduct } from "@/lib/orders/public-menu";
import type { OrderSource } from "@/lib/orders/types";

const PESO = "₱";

export function PublicOrderForm({ menu, source, sourceRef }: { menu: PublicMenuProduct[]; source: OrderSource; sourceRef: string }) {
  const [state, setState] = useState(() => createInitialState(menu, () => crypto.randomUUID()));
  // The honeypot's value. A human never sees the field, so anything here is a bot.
  const [trap, setTrap] = useState("");

  const selected = getSelectedLines(state);
  const total = getOrderTotal(state);
  const blocker = getSubmitBlocker(state);
  const busy = state.status.kind === "submitting";

  async function submit() {
    // UX guard only -- F2's derived order id remains the correctness boundary for duplicates.
    if (!canSubmit(state)) return;

    const body = buildRequestBody(state, { source, sourceRef }, trap);
    setState((current) => markSubmitting(current));

    try {
      const response = await fetch("/api/public-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // Any parseable body is the contract; anything else is treated as a temporary failure rather
      // than guessed at.
      const parsed = (await response.json().catch(() => null)) as PublicOrderResponse | null;
      setState((current) => (parsed ? applyResponse(current, parsed) : applyTransportFailure(current)));
    } catch {
      // Timeout, offline, DNS. The order may in fact have been created, so the key is kept and a
      // retry is answered as a replay.
      setState((current) => applyTransportFailure(current));
    }
  }

  if (state.status.kind === "received") {
    return (
      <section className="mx-auto w-full max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-[#e1d4c4] bg-white p-6 text-center">
          <h1 className="text-xl font-semibold text-[#5f4a3d]">Order received</h1>
          {/* NOT "confirmed" -- the persisted order is `new` until Aly & Pon reviews it. */}
          <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">
            Thanks! We received your order request. We&rsquo;ll contact you on the number you gave to confirm your order and arrange pickup.
          </p>
          <p className="mt-2 text-xs leading-5 text-[#6f5a4c]">Nothing has been charged.</p>
          <button className="mt-6 h-11 w-full rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white" onClick={() => setState((current) => startNewOrder(current, () => crypto.randomUUID()))} type="button">
            Place another order
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-lg px-4 py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold text-[#5f4a3d]">Aly &amp; Pon</h1>
        <p className="text-sm text-[#6f5a4c]">Order for pickup</p>
      </header>

      {state.status.kind !== "editing" && state.status.kind !== "submitting" ? (
        <div className={`mb-4 rounded-md p-3 text-sm leading-6 ${state.status.kind === "error" ? "bg-[#fdeaea] text-[#8a3b3b]" : "bg-[#fff2d8] text-[#7a531d]"}`} role="status">
          {state.status.message}
        </div>
      ) : null}

      {state.menu.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-center text-sm text-[#6f5a4c]">Nothing is available to order right now. Please check back soon.</p>
      ) : (
        <div className="space-y-3">
          {state.menu.map((product) => {
            const image = getSafePublicImage(product.image);
            return (
              <article className="rounded-lg border border-[#e1d4c4] bg-white p-4" key={product.productId}>
                <div className="flex items-start gap-3">
                  {/* Rendered only for a same-origin path under /product-images/. Anything else is
                      dropped -- see getSafePublicImage. */}
                  {image ? <Image alt="" className="h-16 w-16 shrink-0 rounded-md object-cover" height={64} src={image} width={64} /> : null}
                  <h2 className="text-base font-semibold text-[#5f4a3d]">{product.productName}</h2>
                </div>

                <ul className="mt-3 space-y-2">
                  {product.formats.map((format) => {
                    const quantity = state.quantities[format.sellingFormatId] ?? 0;
                    return (
                      <li className="flex flex-wrap items-center justify-between gap-2" key={format.sellingFormatId}>
                        <div className="min-w-0">
                          <p className="text-sm text-[#5f4a3d]">{format.formatName}</p>
                          <p className="text-xs text-[#6f5a4c]">
                            {PESO}{toDisplayPrice(format.unitPrice)} · {format.piecesPerUnit} {format.piecesPerUnit === 1 ? "piece" : "pieces"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button aria-label={`Remove one ${product.productName} ${format.formatName}`} className="h-9 w-9 rounded-md border border-[#d8c7b7] text-lg leading-none text-[#5f4a3d] disabled:opacity-40" disabled={busy || quantity === 0} onClick={() => setState((current) => setQuantity(current, format.sellingFormatId, quantity - 1))} type="button">
                            −
                          </button>
                          <span aria-live="polite" className="w-6 text-center text-sm font-semibold text-[#5f4a3d]">{quantity}</span>
                          <button aria-label={`Add one ${product.productName} ${format.formatName}`} className="h-9 w-9 rounded-md border border-[#d8c7b7] text-lg leading-none text-[#5f4a3d] disabled:opacity-40" disabled={busy} onClick={() => setState((current) => setQuantity(current, format.sellingFormatId, quantity + 1))} type="button">
                            +
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </article>
            );
          })}
        </div>
      )}

      <form
        className="mt-5 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="grid gap-1 text-sm font-medium text-[#5f4a3d]">
          Your name
          <input autoComplete="name" className="h-11 rounded-md border border-[#d8c7b7] bg-white px-3" disabled={busy} onChange={(event) => setState((current) => setContact(current, { customerName: event.target.value }))} required value={state.contact.customerName} />
        </label>

        <label className="grid gap-1 text-sm font-medium text-[#5f4a3d]">
          Mobile number
          <input autoComplete="tel" className="h-11 rounded-md border border-[#d8c7b7] bg-white px-3" disabled={busy} inputMode="tel" onChange={(event) => setState((current) => setContact(current, { phone: event.target.value }))} required type="tel" value={state.contact.phone} />
        </label>

        <label className="grid gap-1 text-sm font-medium text-[#5f4a3d]">
          When would you like it? <span className="text-xs font-normal text-[#6f5a4c]">(optional)</span>
          <input className="h-11 rounded-md border border-[#d8c7b7] bg-white px-3" disabled={busy} onChange={(event) => setState((current) => setContact(current, { requestedTime: event.target.value }))} placeholder="Saturday afternoon if possible" value={state.contact.requestedTime} />
        </label>

        <label className="grid gap-1 text-sm font-medium text-[#5f4a3d]">
          Anything else? <span className="text-xs font-normal text-[#6f5a4c]">(optional)</span>
          <textarea className="min-h-20 rounded-md border border-[#d8c7b7] bg-white p-3" disabled={busy} onChange={(event) => setState((current) => setContact(current, { notes: event.target.value }))} value={state.contact.notes} />
        </label>

        {/* Honeypot. Hidden from people, irresistible to bots. */}
        <input aria-hidden="true" autoComplete="off" className="hidden" name="trap" onChange={(event) => setTrap(event.target.value)} tabIndex={-1} value={trap} />

        <div className="mt-2 flex items-center justify-between border-t border-[#e8dccd] pt-3">
          <span className="text-sm text-[#5f4a3d]">Total</span>
          <span className="text-lg font-semibold text-[#5f4a3d]">{PESO}{toDisplayPrice(total)}</span>
        </div>

        <button className="h-12 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !canSubmit(state)} type="submit">
          {busy ? "Sending…" : "Place order request"}
        </button>

        {blocker && !busy ? <p className="text-center text-xs text-[#6f5a4c]">{blocker}</p> : null}

        <p className="text-center text-xs leading-5 text-[#6f5a4c]">
          {selected.length > 0 ? `${selected.length} item${selected.length === 1 ? "" : "s"} · ` : ""}
          We&rsquo;ll message you to confirm. Nothing is charged now.
        </p>
      </form>
    </section>
  );
}
