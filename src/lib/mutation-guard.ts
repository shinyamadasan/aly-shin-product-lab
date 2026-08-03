// A small, key-scoped in-flight guard: prevents a second call for the same key from running
// while the first is still in progress. Generalizes the synchronous useRef<boolean> re-entrancy
// guard this codebase already uses for Bake/Purchase-Import double-click protection (see
// bake-page.tsx's isConfirmingRef, set synchronously as the very first statement because a
// useState-only guard was empirically shown to miss a true synchronous double-click -- setState's
// effect on a render's closures only lands on the next render) to track multiple independent keys
// at once -- e.g. one per Inventory Timeline row -- so guarding one row's in-flight action never
// disables an unrelated row's.
export type MutationGuard<Key> = {
  isActive: (key: Key) => boolean;
  // Runs fn() for this key unless a run for the same key is already in progress, in which case it
  // does nothing and returns undefined -- the caller should treat that as "already handled, do
  // nothing." Always releases the key once fn() settles, whether it resolves or rejects, so a
  // failed attempt can be retried.
  run: <T>(key: Key, fn: () => Promise<T>) => Promise<T | undefined>;
};

export function createMutationGuard<Key>(): MutationGuard<Key> {
  const active = new Set<Key>();

  return {
    isActive: (key) => active.has(key),
    async run(key, fn) {
      if (active.has(key)) {
        return undefined;
      }
      active.add(key);
      try {
        return await fn();
      } finally {
        active.delete(key);
      }
    },
  };
}
