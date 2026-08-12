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
