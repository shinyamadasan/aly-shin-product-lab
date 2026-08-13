# Content MVP Quality Gate Notes

## S3B model bakeoff result

S3B completed and merged in `383197e`.

The blinded model-quality gate selected Opus as the frozen default model decision for the Content MVP:

- Opus: 7 wins
- Sonnet: 3 wins
- Opus won 5 of 6 strong-confidence judgments
- Opus won all four format-specific production cases: photo, reel, carousel, story

Operationally, both models were 16/16 schema-valid on the first attempt, with zero retries and effectively tied combined latency. Sonnet used about 16% less subscription usage, but the quality result was decisive enough to freeze Opus as the Content MVP default.

This note records the quality-gate decision only. Opus is the preferred/default Content MVP model decision, but it is not hardcoded into S3B or S3B.1. Runtime provider/model configuration is intentionally owned by S3C; S3C-A established the provider-neutral runtime direction.

## S3B.1 factuality regression notes

S3B.1 preserves the Stage 1 format decision for the MVP and hardens the prompt around closed-world factuality: no invented product specifics, no inferred experiment outcomes, and no newness or menu-status inference from missing marketing history.

The first live Opus S3B.1 regression structured all three cases on the first attempt with zero retries, assembled successfully, and passed S2 validation. Case 04 passed factuality: the prompt did not invent an experimental result from the supplied "browner butter and longer rest" test fact. Cases 02 and 07 failed because Opus treated CTA, ordering, delivery, and fulfillment wording as generic marketing boilerplate instead of factual business claims.

The commercial-action fix made transactional CTA and fulfillment language factual claims: order, delivery, pickup, availability, message-to-order, and comparable hashtags require explicit supporting facts. If those facts are absent, the CTA must stay non-transactional.

The final live Opus S3B.1 regression passed 3/3. Cases 02, 04, and 07 all structured on the first attempt with zero retries, assembled successfully, and passed S2 validation. Case 02 used a non-transactional CTA and made no unsupported ordering, delivery, availability, newness, or menu-status claim. Case 04 preserved the experiment/test-outcome boundary. Case 07 correctly skipped Stage 1 because `formatHint` was `photo`, made no unsupported commercial-action claim, and used "something sweet" / `#coffeeandsomethingsweet` only as accepted category-level creative framing in the Aly & Pon bakery context.

Generic category or creative-framing language may be used when reasonably supported by the subject and brand context, such as "something sweet", "baked treat", "coffee break", "afternoon treat", or "kitchen moment". Specific factual claims still require grounding: texture, taste specifics, ingredients, freshness, size, availability, fulfillment, sales status, novelty/menu status, customer reaction, experiment outcome, and causal conclusion.

The remaining repetition concern is deferred to Content Memory rather than S3B.1 prompt scope.

## S3C-B: the Claude CLI provider, and one finding that qualifies this document

S3C-B implements `ClaudeCliProvider`, the first real `AiTextProvider`. It runs the locally
installed, subscription-authenticated Claude Code CLI. There is no Anthropic API client, no SDK
dependency, and no `ANTHROPIC_API_KEY` requirement; `--bare` is deliberately never passed, because
the installed CLI's own help states that under `--bare` "Anthropic auth is strictly
ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never read)".

Opus lives in this provider's configuration and nowhere else. `CLAUDE_CLI_DEFAULT_MODEL = "opus"`
is provider-specific vocabulary. A future Codex provider must use its own configured default and
must never inherit "opus" across a fallback boundary. Precedence is: explicit
`AiTextRequest.model`, then the provider's configured default, then Opus.

### Finding: ambient repository instructions were reaching the model

Probing the installed CLI (2.1.222) during S3C-B preflight showed that `--system-prompt` does NOT
suppress `CLAUDE.md` / `AGENTS.md` auto-discovery. A control prompt run inside this repository,
with an explicit `--system-prompt` set, still answered YES to "do your instructions mention a
bakery, Aly, Pon, or a Product Lab". The same probe with `--safe-mode` answered NO.

This matters for two reasons:

1. Ambient repository instructions silently joining the context change the *effective* prompt,
   which would quietly undermine S3B's frozen canonical prompt.
2. The blinded model quality gate recorded above ran WITHOUT `--safe-mode`. Both models were
   affected identically, so the Opus/Sonnet comparison remains a fair one and the 7-3 result
   stands. But the gate's absolute outputs were produced with this repository's `AGENTS.md` in
   context, and are therefore not a perfectly clean measurement of the canonical prompt alone.

`ClaudeCliProvider` passes `--safe-mode` for this reason. It disables `CLAUDE.md`, skills, plugins,
hooks, MCP servers and custom agents while explicitly leaving authentication, model selection and
permissions working normally, so subscription OAuth is unaffected. This was verified live.

### Verified response-envelope facts

Confirmed against the real CLI rather than assumed:

- Structured output is returned as a parsed object under `structured_output`, with the same value
  as a JSON string in `result`.
- `usage.input_tokens` and `usage.output_tokens` are honest per-call token counts and are the only
  usage fields mapped. `total_cost_usd` is deliberately NOT mapped: under a subscription it is an
  API-equivalent estimate, not money spent.
- `modelUsage` is keyed by canonical model id, and can legitimately contain MORE than one key. The
  provider therefore never reads "the first key" blindly.
- A run can exit non-zero with an EMPTY stderr while stdout still holds a valid JSON error
  envelope. Classification reads the envelope first, regardless of exit code.
