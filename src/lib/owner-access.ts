// Wave B -- how the application shell reads the server's owner verdict.
//
// Pure, so every branch below is provable without a network, a session or a DOM. The credential and
// the allowlist live server-side in production-auth-server.ts; the RULE lives in production-auth.ts;
// this module is only the client's interpretation of the answer it was given.
//
// FAIL-CLOSED BY CONSTRUCTION. Exactly one shape grants access: HTTP 200 carrying `owner: true`.
// Everything else -- a refusal, a misconfiguration, a 500, a body that is not what we asked for, a
// network that never answered -- is NOT access. That ordering matters more than it looks: a gate
// that opens when it cannot reach its authority is not a gate, and this one is reached over a
// network that can fail.

export type OwnerAccessState =
  // The check has not answered yet. Not a verdict -- the shell shows nothing privileged here.
  | "checking"
  // The server verified this token and says it belongs to the owner.
  | "owner"
  // The server verified this token and says it does not. A real, final refusal.
  | "denied"
  // No usable verdict: unconfigured, server error, unreadable body, or the request never landed.
  // Deliberately distinct from "denied" so the shell can offer a retry instead of accusing a
  // legitimate owner of not being one.
  | "unavailable";

export type OwnerAccessOutcome =
  | { kind: "response"; status: number; body: unknown }
  // A fetch that threw: DNS, offline, aborted, CORS. There is no status to reason about.
  | { kind: "unreachable" };

function isOwnerTrue(body: unknown): boolean {
  return Boolean(body) && typeof body === "object" && !Array.isArray(body) && (body as { owner?: unknown }).owner === true;
}

export function resolveOwnerAccess(outcome: OwnerAccessOutcome): OwnerAccessState {
  if (outcome.kind === "unreachable") {
    return "unavailable";
  }

  // 200 alone is not enough. A proxy, a login portal or a rewritten route can all return 200 with a
  // body that says nothing about ownership, and treating that as a grant would make the gate depend
  // on the network's honesty rather than the server's answer.
  if (outcome.status === 200) {
    return isOwnerTrue(outcome.body) ? "owner" : "unavailable";
  }

  // The two verdicts the route actually issues about the caller. 401 is folded in with 403 on
  // purpose: from the shell's side both mean "this session is not getting in", and the route already
  // answers missing-token and invalid-token identically so that probing reveals nothing.
  if (outcome.status === 401 || outcome.status === 403) {
    return "denied";
  }

  return "unavailable";
}

// The identity a stored verdict is ABOUT. A verdict computed for one access token says nothing
// about another, so the shell keys it rather than trusting that the session has not changed
// underneath it. The retry counter is part of the key so an explicit "Try again" is genuinely
// unanswered until the server answers it, instead of showing the previous failure as current.
export function ownerVerdictKey(accessToken: string, checkAttempt: number): string {
  return `${accessToken}:${checkAttempt}`;
}

// The owner-facing wording for a real refusal. Deliberately says what to DO (sign in as the owner)
// and never why the account was refused -- an account that is not the owner learns only that.
export const OWNER_ACCESS_DENIED_HEADLINE = "This account can't open Product Lab.";
export const OWNER_ACCESS_DENIED_DETAIL =
  "You're signed in, but this account isn't the owner account. Sign out and sign in as the owner.";

// A missing verdict is not an accusation. The owner sees a retry, not a refusal.
export const OWNER_ACCESS_UNAVAILABLE_HEADLINE = "We couldn't check this account just now.";
export const OWNER_ACCESS_UNAVAILABLE_DETAIL =
  "Nothing is wrong with your work. Try again in a moment.";
