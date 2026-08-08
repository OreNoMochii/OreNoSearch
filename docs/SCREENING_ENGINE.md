# Screening engines

Four engines decide which sourced candidates reach a shortlist. The UI presents
them as a choice of one; they are wired in `packages/api/src/composition.ts` and
dispatched by `OutreachOrchestrator` through a single `ScreeningStrategy` port,
so each is interchangeable from the caller's point of view and completely
different underneath.

| UI label | `screeningEngine` | Implementation | LLM calls per candidate |
| --- | --- | --- | --- |
| AI + flight risk | `llm` | `LlmScreeningAdapter` → `ScreeningAgent` | 1 |
| Agentic (grounded) | `agentic` | `AgenticScreeningAdapter` → `screening/pipeline.ts` | 0–3 |
| Tree-based ML | `tree` | `TreeScreeningAdapter` → `jd_tree_scorer.py` | 0 |
| Tree + AI hybrid | `tree_llm` | `HybridScreeningAdapter` | 0 or 1 |

Two things are true of **all four** and are commonly misattributed to one:

- **Flight-risk scoring runs for every engine.** It happens in
  `OutreachOrchestrator.run()` *after* whichever engine returns its PASS list,
  not inside any engine. The label "AI + flight risk" names the oldest engine
  after a feature all of them have.
- **Every engine returns only `PASS` / `REJECT`.** Richer internal outcomes
  (agentic's `UNCERTAIN`, tree's numeric score) are collapsed at the port
  boundary and preserved only in the audit tables.

---

## 1. AI + flight risk (`llm`)

**One LLM call per candidate.** `ScreeningAgent.verificationAgent()` sends the
JD, the candidate, and optional company intel in a single prompt and gets back
a structured verdict: overall fit score, verified seniority, a per-competency
technical audit, and adversarial flags.

**Concurrency adapts.** Starts at 5 (2 for NVIDIA), ramps to 10 (4 for NVIDIA)
after 15 consecutive successes, and halves on any rate-limit, with a 10–15s
backoff. Verdicts are persisted once per wave, not per candidate.

**Company intel** is batch-loaded once for the whole set and injected into the
prompt as a `[Company Intel]` line. A failure here degrades quality but never
fails the campaign.

### Evidence grounding

The prompt demands verbatim quotes. Until grounding was added, nothing checked
they existed — a model inventing a supporting quote produced a confident,
well-justified PASS built on nothing.

Now every `evidence_quote` is checked against the candidate's own profile text
(`screening/grounding.ts`). If a candidate was heading for **PASS** and *any*
quote is unverifiable, the verdict is **overturned to REJECT**:

```
Verdict overturned: 2 of 3 cited quotes could not be found in the
candidate profile. Unverifiable evidence cannot support a match.
```

The asymmetry is deliberate: rejections are left alone, because fabricated
evidence cannot make a rejection wrong *in the direction that costs us*.

This is a blunt instrument. On a single-call path there is no way to know how
much of the verdict rested on the bad quote, so the whole verdict is discarded
rather than the quote. That is the main structural difference from `agentic`,
which never adjudicates against unverified evidence in the first place.

**Watch:** `overturnedByGrounding` in `llm_audit_complete`. If it approaches
the rejection count, the model is not screening — it is hallucinating and being
caught. That is a signal to change model, not to tune the prompt.

---

## 2. Agentic (grounded) (`agentic`)

A six-stage funnel, ordered by cost. Each stage is more expensive than the last
and only sees what the previous one could not settle.

### Stage 0 — Rubric compilation (once per campaign)

The JD is compiled into a structured rubric: knockouts (hard must-haves) and
weighted competencies. Cached by JD hash.

If compilation fails, the engine **returns nothing**. It does not fall back to
another engine — that would produce results the operator believes came from
this one.

If `SCREENING_REQUIRE_APPROVED_RUBRIC` is set and the rubric is unapproved, it
also returns nothing.

### Stage 1 — Deterministic gates (free)

`applyGates()` — pure code, no model. Rejects on knockout failures and campaign
constraints (min/max experience). This rejects the majority, which is what
makes three model calls affordable on the survivors.

Checks that cannot be evaluated because the data is absent are recorded as
**indeterminate** and passed through rather than assumed either way.

### Stage 3 — Evidence extraction

A model extracts quotes supporting each requirement. Every quote is verified
against the profile before it goes anywhere. Verified quotes reach scoring;
fabricated ones are counted and discarded.

### Stage 4 — Adjudication

A model scores competencies **over verified quotes only**, producing a weighted
score. It never sees an unverified quote, so it cannot be persuaded by one.

### Stage 5 — Challenger (conditional)

Runs only when the provisional decision is *not* REJECT — challenging a clear
rejection cannot change the outcome and would double the cost of the cheapest
decisions in the batch.

A second model argues *against* the candidate. Its objections are themselves
quote-verified: unverifiable objections are **discarded**. A challenger
inventing objections silently suppresses good candidates, and that failure
looks like diligence, which is why `discardedObjections` is logged.

The challenger should be a different model family from the adjudicator —
shared lineage means shared blind spots, and two models failing identically is
indistinguishable from one being right. A mismatch logs
`challenger_shares_family_with_adjudicator`.

### Stage 6 — Decision

Produces `PASS`, `REJECT`, or **`UNCERTAIN`** — the third outcome the `llm`
path does not have.

`UNCERTAIN` is reported to the orchestrator as `REJECT` so nobody is emailed on
a maybe, but recorded as `UNCERTAIN` in `screening_audit` for a review queue.
Contacting someone the system is unsure about is the exact failure this
pipeline exists to prevent.

### Audit trail

Every candidate writes a row to `screening_audit`: gate results, evidence,
adjudication, challenge, quote counts, tokens, duration. This engine is the
only one that can reconstruct *why* after the fact.

---

## 3. Tree-based ML (`tree`)

**No LLM calls. And — despite the name — no ML model.**

This is worth stating plainly because the UI label is misleading.
`jd_tree_scorer.py` once fitted a `GradientBoostingClassifier` on every request:
opening a connection, pulling 15,000 rows of resume text, engineering features
over all of them, and training from scratch before scoring a single candidate
it was actually asked about — tens of seconds of CPU per campaign.

The labels that model was trained on came from `make_labels()`, which is a
deterministic arithmetic function of the very feature matrix the model was
handed. **The GBM was being trained to approximate a rule the code already
computes exactly.** The fetch and the fit bought nothing but latency and a
little smoothing, so both were removed.

What runs now is the rule directly — a weighted scorecard:

| Signal | Contribution |
| --- | --- |
| Experience in JD range | +2.5 |
| Seniority match | +2.0 |
| Current-role domain keywords (≥3) | +3.0 |
| Role-title domain match | +1.5 |
| Domain keyword density (≥70th pct) | +1.5 |
| Domain purity (≥0.7) | +1.5 |
| Location match | +1.0 |
| Language inference | +0.5 each |
| Short stints | −1.0 |
| Seniority gap ≥2 | −2.0 |
| Over 2× max experience | −1.5 |
| Cross-domain contamination (≥10 kw) | −2.0 |
| **Excluded-domain keywords (≥2)** | **−3.0** |

The raw score is mapped through a logistic centred on the batch's **88th
percentile**, preserving the original selection semantics (top ~12% pass).
`TREE_PASS_THRESHOLD = 0.5` in the TypeScript adapter therefore still means
what it always meant.

**Consequences of the percentile centring**, which matter and are easy to miss:

- The threshold is **relative to the batch**, not absolute. Roughly the top 12%
  pass regardless of whether anyone is actually qualified. A batch of 100
  unsuitable candidates still yields ~12 passes.
- Scores are **not comparable across campaigns**. A 0.7 in one batch is not the
  same standard as a 0.7 in another.

Use it for cheap ranking and pre-filtering, not as a quality bar on its own.

---

## 4. Tree + AI hybrid (`tree_llm`)

Tree pre-filter, then LLM audit on the survivors.

1. `TreeScreeningAdapter.score()` ranks everyone (free, local).
2. Candidates below `TREE_PASS_THRESHOLD` are rejected outright with
   `"Rejected by tree pre-filter (score below threshold)"`.
3. Survivors go through the full `llm` path, grounding included.

On a 1,000-candidate pool at a typical tree pass rate, this is the difference
between ~1,000 paid LLM calls and a few hundred.

**If the tree stage returns nothing, the hybrid stops** rather than falling
through to a full LLM audit. Falling through would silently turn the
cost-saving engine into the most expensive one. It logs
`hybrid_tree_stage_empty`.

> Historical note: `composition.ts` previously mapped `tree_llm` to a bare
> `LlmScreeningAdapter` with the comment *"Or a dedicated Hybrid adapter"*, so
> selecting Hybrid ran a full LLM audit over every candidate and saved nothing.

---

## Why the Provider dropdown disappears

The **Model** section — provider *and* model — is gated in
`OutreachSidebar.tsx`:

```ts
const usesLlm = props.screeningEngine === 'llm' || props.screeningEngine === 'tree_llm';
```

So the provider selector only appears for **AI + flight risk** and
**Tree + AI hybrid**. This is correct rather than a bug, but for two different
reasons:

- **Tree** makes no LLM calls at all. There is nothing to choose.
- **Agentic** makes plenty — but it does **not** use the UI's single model
  selection. It uses a different model per stage, read from config, because the
  stages have genuinely different requirements (a challenger must not share a
  family with the adjudicator; extraction and adjudication want different
  trade-offs).

Agentic's models come from environment variables, not the UI:

| Stage | Env var | Default |
| --- | --- | --- |
| Compiler | `SCREENING_MODEL_COMPILER` | `nvidia:meta/llama-3.3-70b-instruct` |
| Extractor | `SCREENING_MODEL_EXTRACTOR` | `nvidia:meta/llama-3.3-70b-instruct` |
| Adjudicator | `SCREENING_MODEL_ADJUDICATOR` | `nvidia:nvidia/llama-3.1-nemotron-70b-instruct` |
| Challenger | `SCREENING_MODEL_CHALLENGER` | `nvidia:deepseek-ai/deepseek-r1` |
| Escalation | `SCREENING_MODEL_ESCALATION` | `nvidia:meta/llama-3.1-405b-instruct` |

None are currently overridden in `.env`, so all five defaults are in force.

**If you want per-stage model choice in the UI**, that is a real feature and
does not exist yet — it needs five selectors (or a preset), plumbed through
`ScreeningOptions` into `modelFor()`, which currently reads config directly and
ignores anything the request carries.

Providers themselves (`deepinfra`, `nvidia`) are derived from
`MODEL_CATALOG` — `Array.from(new Set(models.map(m => m.provider)))` — so a
provider appears in the dropdown only if at least one catalogue entry uses it.
The API already returns `provider` on every model; nothing is filtered
server-side.

---

## Choosing an engine

| Situation | Engine |
| --- | --- |
| Large pool, cost-sensitive, ranking is enough | **Tree** |
| Large pool, want LLM quality without auditing all of it | **Tree + AI hybrid** |
| Need a defensible audit trail, or false positives are expensive | **Agentic** |
| Small pool, want one straightforward judgement per candidate | **AI + flight risk** |

Agentic is the only engine that can abstain (`UNCERTAIN`) and the only one that
writes a full audit trail. Tree is the only one that is free. The other two sit
between those poles.

---

## Observability

Log events per engine, for correlating a campaign after the fact.

**All campaigns** — `campaign_started` (pre-screening filters: resolved,
same-company removed, already-contacted removed), `campaign_screening_finished`
(submitted vs returned vs `noVerdict`), `risk_scoring_complete` (coverage by
`basis`), `campaign_complete`.

**`llm`** — `llm_audit_started`, `llm_audit_progress` (per wave, with ETA),
`llm_candidate_verdict` (per-competency scores, fit score, quote counts),
`llm_evidence_not_grounded`, `llm_audit_complete` (`overturnedByGrounding`,
`errored`, `unaccounted`, pass rate, timing).

**`agentic`** — `agentic_screening_started`, `agentic_stage_gates_failed`
(which knockout ids), `agentic_stage_evidence` (verified/fabricated,
requirements addressed), `agentic_stage_challenge` (`discardedObjections`),
`agentic_candidate_decided` (full trace: path, per-stage timings, tokens, cost),
`agentic_challenger_overturned`, `agentic_screening_complete` (stage funnel,
top knockouts, p50/p95 latency).

**`tree`** — `tree_scorer_started`, `tree_scorer_complete`.

**`tree_llm`** — `hybrid_prefilter_complete`, `hybrid_tree_stage_empty`, then
all of the `llm` events for the survivors.

Two fields worth watching specifically:

- **`overturnedByChallenger`** (agentic) — whether stage 5 changes any answers.
  If it never fires, the challenger is pure cost.
- **`topKnockouts`** (agentic) — one knockout rejecting most of a batch is
  usually a mis-compiled rubric, not a uniformly unqualified list.
