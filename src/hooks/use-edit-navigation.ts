import { useEffect, useRef } from "react";

// Every "Edit" button in this app sets a local `editingX` state and lets the form remount via
// `key={entity?.id ?? "new-X"}` (either the whole form component, as Costing does, or just the
// inner <form>, as every other entity does) -- but none of them scroll the form into view or
// focus its first field. This hook owns exactly that missing piece, not the editingX state
// itself (every call site keeps its own useState/setEditingX, unchanged).
//
// recordKey should be `entity?.id ?? null` -- the same identity used for the `key=` prop. Keying
// the effect on it means it reruns exactly when the edit target changes regardless of which
// remount style a given form uses, and React guarantees effects run after that commit's DOM
// (including remounted children) is in place, so this naturally waits for the edit form to render.
//
// The actual scroll/focus is deferred one more frame via requestAnimationFrame, cancelled in the
// cleanup. Two reasons: it lets layout settle after the DOM commit before measuring scroll
// position, and -- more importantly -- clicking Edit on record A then quickly on record B fires
// this effect twice in succession; without the cancel, A's still-pending scroll/focus could win
// the race and fire after B's, landing the user on the wrong record.
export function useEditNavigation<Editor extends HTMLElement = HTMLElement, Field extends HTMLElement = HTMLElement>(
  recordKey: string | null,
) {
  const editorRef = useRef<Editor>(null);
  const fieldRef = useRef<Field>(null);

  useEffect(() => {
    if (!recordKey) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      editorRef.current?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
      fieldRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [recordKey]);

  return { editorRef, fieldRef };
}
