import test from "node:test";
import assert from "node:assert/strict";
import { createMutationGuard } from "../src/lib/mutation-guard.ts";

// A controllable promise, standing in for an in-flight RPC call -- lets a test start a run and
// hold it open long enough to simulate a second, "rapid" invocation arriving before the first
// settles, without any timers or React rendering involved.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// These tests exercise the extracted guard mechanism that AdjustStockRow (inventory-page.tsx) and
// the Inventory Timeline's Reverse button (inventory-timeline.tsx) are both built on, since this
// repo has no component-rendering test harness (no jsdom/testing-library dependency) to click a
// real button twice against. The guard is the actual, shared re-entrancy mechanism both call
// sites use -- these tests exercise it directly rather than reimplementing its logic.

test("1/2. a rapid second call for the same key while the first is in flight does not run fn again", async () => {
  const guard = createMutationGuard<string>();
  let callCount = 0;
  const first = deferred<void>();

  const firstRun = guard.run("row-1", async () => {
    callCount += 1;
    await first.promise;
  });
  // The "double click": invoked again for the SAME key before the first has settled.
  const secondRun = guard.run("row-1", async () => {
    callCount += 1;
  });

  assert.equal(await secondRun, undefined, "the re-entrant call must be a no-op, not a second mutation");
  first.resolve();
  await firstRun;

  assert.equal(callCount, 1, "fn must have run exactly once -- one inventory mutation, one ledger row");
});

test("3. a failed run releases the guard so the operator can retry", async () => {
  const guard = createMutationGuard<string>();

  await assert.rejects(() =>
    guard.run("row-1", async () => {
      throw new Error("network error");
    }),
  );

  assert.equal(guard.isActive("row-1"), false, "the guard must release even after a rejection");

  let secondCallRan = false;
  await guard.run("row-1", async () => {
    secondCallRan = true;
  });
  assert.equal(secondCallRan, true, "a retry after a failure must be allowed to run");
});

test("4/5. isActive reflects the in-flight state a disabled button/row is bound to", async () => {
  const guard = createMutationGuard<string>();
  const inFlight = deferred<void>();

  assert.equal(guard.isActive("row-1"), false);
  const runPromise = guard.run("row-1", async () => {
    await inFlight.promise;
  });
  assert.equal(guard.isActive("row-1"), true, "isActive must be true while the run is in progress");

  // A second attempt on the SAME key while the disabled state would be showing.
  let reenteredWhileActive = false;
  await guard.run("row-1", async () => {
    reenteredWhileActive = true;
  });
  assert.equal(reenteredWhileActive, false, "a second attempt on the same row must not run while it is disabled");

  inFlight.resolve();
  await runPromise;
  assert.equal(guard.isActive("row-1"), false, "isActive must be false once the run settles, re-enabling the row");
});

test("6. guarding one key does not block a concurrent run for a different key", async () => {
  const guard = createMutationGuard<string>();
  const rowA = deferred<void>();

  const runA = guard.run("row-A", async () => {
    await rowA.promise;
  });
  assert.equal(guard.isActive("row-A"), true);
  assert.equal(guard.isActive("row-B"), false, "an unrelated row must not appear disabled");

  let rowBRan = false;
  await guard.run("row-B", async () => {
    rowBRan = true;
  });
  assert.equal(rowBRan, true, "an unrelated key must be able to run while row-A is still in flight");

  rowA.resolve();
  await runA;
});
