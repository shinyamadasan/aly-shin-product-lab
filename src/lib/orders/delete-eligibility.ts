// Whether the "Delete permanently" button should be OFFERED. This is presentation only: the database
// (safe_delete_order, supabase/migrations/20260919120000_safe_delete_order.sql) re-checks everything
// under a row lock and is the only thing that decides. It also checks what a browser cannot see --
// stock reservations and finished-stock movements -- so a button shown here can still be refused.
//
// The payment wording matters. The schema keeps no payment history: "Clear payment record" nulls the
// fields and leaves no trace. So "no payment fields set" means no payment is on record NOW, never
// that none was ever recorded, and nothing in the UI may claim the latter.

import type { Order } from "./types.ts";

export function appearsSafeToDelete(order: Pick<Order, "status" | "paymentStatus" | "paymentMethod" | "paidAt" | "paidAmount" | "refundedAt" | "entryMethod">): boolean {
  return (
    order.status === "new" &&
    order.entryMethod === "manual" &&
    order.paymentStatus === "unpaid" &&
    order.paymentMethod === null &&
    order.paidAt === null &&
    order.paidAmount === null &&
    order.refundedAt === null
  );
}

export function buildDeleteConfirmation(customerName: string | null): string {
  return [
    `Permanently delete this order${customerName ? ` for ${customerName}` : ""}?`,
    "",
    "This removes the order and its line items and cannot be undone.",
    "",
    "Use Cancel instead if this was a real customer order.",
  ].join("\n");
}
