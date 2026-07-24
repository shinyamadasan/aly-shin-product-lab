# Rule Category: Quality

Part of the Product Lab Rule Engine — see `RULE_ENGINE.md`. Grounded in the same domain
knowledge the AI Review Framework uses (`ai-review/knowledge/food-science.md`,
`packaging.md`, and the relevant product-specific file) so the deterministic rule and the AI
specialist assessment can't contradict each other — the rule is the ground truth; the specialist
interprets it, per `RULE_ENGINE.md` § Integration.

Category priority weight: **6 for food safety (QUAL-005) specifically — second only to
Financial. 5 for the rest** (shelf-life, packaging, temperature, texture) — see
`RULE_ENGINE.md` § Rule Priority for why food safety is split out above its siblings.

**Known data gap, applying to every rule in this category:** there is no dedicated schema field
for shelf-life tests, temperature tests, or texture evaluations today. Every rule here evaluates
against free-text batch/tasting notes until a structured field exists — treat a Pass from this
category as weaker evidence than a Pass in Financial or Production, and say so in the output.

---

### QUAL-001 — Shelf-Life Test Completed

- **Purpose:** Distinguish an assumed shelf life from a measured one.
- **Inputs:** Batch/tasting-checkpoint notes referencing a timed freshness check (e.g. "24 hours
  post-bake," "Day 3").
- **Evaluation logic:** A test is "completed" if at least two time-separated checkpoints exist
  for the current formula version, with a texture/taste note at each.
- **Pass:** 2+ time-separated checkpoints logged for the current formula, per
  `ai-review/workflows/product-experiment-design.md`'s structure.
- **Warning:** One checkpoint exists (fresh-only), no later-timepoint check.
- **Fail:** No checkpoint of any kind exists.
- **Severity:** Blocker at Fail for products with a real spoilage/staling risk (see
  `knowledge base` — dairy or high-moisture items); Warning otherwise.
- **Output message:** *"No shelf-life checkpoint beyond initial tasting exists for {product}."*
- **Next action:** *"Run the shelf-life experiment in
  `ai-review/workflows/product-experiment-design.md` — same batch, checked at 24h and 48h."*

### QUAL-002 — Packaging Validation

- **Purpose:** Catch the exact gap already found this session — a nonzero packaging cost is not
  evidence packaging was tested.
- **Inputs:** `costing.packagingCost` and its line-item notes.
- **Evaluation logic:** Packaging is "validated" only if a note ties it to an actual test result
  (freshness held, no leakage, survived transport), not just a cost entry.
- **Pass:** Packaging cost is present AND a test note is attached.
- **Warning:** Packaging cost is present but no test note exists — this is the default state for
  most costings today.
- **Fail:** No packaging cost at all where one is clearly needed (a sellable product with PHP 0
  across every packaging line).
- **Severity:** Warning by default; Blocker if the product is within one launch decision of
  going to preorder (see LAUNCH-004).
- **Output message:** *"Packaging cost is PHP {cost} but no test confirms it holds up under real
  delivery/storage conditions."*
- **Next action:** *"Run a packaging stress test (see `knowledge/packaging.md` for what 'tested'
  actually means) and log the result."*

### QUAL-003 — Temperature Test

- **Purpose:** For temperature-sensitive products (dairy-based drinks especially), confirm
  cold-chain/temperature behavior has actually been checked, not assumed.
- **Inputs:** Batch/tasting notes referencing temperature conditions during a test.
- **Evaluation logic:** Applicable only to products flagged temperature-sensitive (category =
  Coffee/dairy-based, or any product with a TCS ingredient — see `knowledge/food-science.md`).
  Not applicable to shelf-stable baked goods.
- **Pass:** A test exists under conditions matching the real intended delivery method (e.g.
  no-ice transport time actually measured).
- **Warning:** A test exists but under idealized conditions (e.g. always kept refrigerated,
  never tested at real delivery/ambient conditions).
- **Fail:** No temperature test exists for a temperature-sensitive product.
- **Severity:** Blocker at Fail for temperature-sensitive products; not applicable otherwise.
- **Output message:** *"{product} is temperature-sensitive but has no logged test under real
  delivery conditions."*
- **Next action:** *"Test under the actual planned delivery conditions (time, ice/no ice,
  ambient temperature), not just refrigerated storage."*

### QUAL-004 — Texture Evaluation

- **Purpose:** Confirm texture (not just taste) has been explicitly evaluated — a common blind
  spot when tasting feedback focuses on flavor.
- **Inputs:** `textureNotes` on the batch, `TastingFeedback` comments.
- **Evaluation logic:** Present if `textureNotes` is non-empty on the most recent batch, or a
  tasting comment explicitly addresses texture.
- **Pass:** Texture explicitly addressed for the current formula version.
- **Warning:** Texture only implied indirectly (e.g. inferred from a general comment).
- **Fail:** No texture information at all.
- **Severity:** Info (Warning if this is the most recent batch, mirroring DEV-006).
- **Output message:** *"No explicit texture note for {product}'s current formula."*
- **Next action:** *"Add a texture-specific note next time this formula is tasted."*

### QUAL-005 — Food Safety Checks

- **Purpose:** The hard-line safety gate — distinct from taste/texture/shelf-life quality, this
  checks for unresolved risk to the person eating the product.
- **Inputs:** Ingredient list (checking for known TCS/allergen ingredients — dairy, egg), stated
  storage/delivery plan, any hazard note logged.
- **Evaluation logic:** Flags when a TCS ingredient is present (per `knowledge/food-science.md`)
  and no cold-chain or time-limit plan is stated for the product's actual sale method.
- **Pass:** No TCS ingredient risk, or a TCS risk exists with a stated, real mitigation plan
  (cold-chain, time limit, or a stated intended-consumption window).
- **Warning:** A TCS risk exists with a partial/unclear mitigation plan.
- **Fail:** A TCS risk exists with no mitigation plan stated at all.
- **Severity:** **Blocker at Fail — this is the framework's hardest-line rule outside Financial.**
  See `RULE_ENGINE.md` § Rule Priority for why this outranks every other Quality rule.
- **Output message:** *"{product} contains {ingredient} (time/temperature-sensitive) with no
  stated cold-chain or time-limit plan for {sale method}."*
- **Next action:** *"State and test an explicit cold-chain or time-limit plan before this product
  goes anywhere near a real customer."*
