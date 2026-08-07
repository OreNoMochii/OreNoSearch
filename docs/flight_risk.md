# Flight risk: audit, correction, and plan

Status of the scoring model that ranks a screened candidate by how likely they
are to leave their current employer. Written 2026-08-07.

Short version: every performance number this subsystem has ever reported is
measuring target leakage, the training label means close to the opposite of
what the endpoint implies, and the served model scores candidates it was
trained on. None of it is recoverable by tuning. The rebuild starts from
calendar dates that were in the scrape all along and had been discarded.

---

## 1. What was wrong

### 1.1 The served model returns in-sample scores

`machine_learning/src/serve_models.py` is the only implementation of the
`/score` contract. It fits XGBoost at import time on the whole of
`candidates_rl_features` with no split, then serves predictions for rows
selected out of that same frame. Every candidate's own row was in the training
set. Held-out performance is not merely bad, it is unmeasured.

Three of the four response fields are also not what the contract
(`packages/api/src/domain/ports.ts`) says they are:

| Field | Documented as | Actually |
| --- | --- | --- |
| `hazard` | "Cox proportional-hazards score" | `100 if pred else 10` — two possible values, from XGBoost |
| `tenureMonths` | "Tenure in the current role, months" | the literal `24` |
| `relevancy` | "LTR relevance against the job description" | `(1 - semantic_drift) * 5`; `jd_text` is ignored |
| `moveProb` | "Probability of changing employer within the horizon" | in-sample; threshold `0.43` tuned on the test set |

### 1.2 The label means "arrived recently", not "about to leave"

`label = current_tenure_months < 10` selects people who *just started* a job.
For a post-screening flight-risk score you want P(leaves within N months).
Someone three months into a new role is among the **least** likely to move, so
for its actual use the target is close to inverted.

It is also mis-derived. `train_rl_flight_risk.py` reads
`candidates_data_science_use_v2.current_tenure_months`, which
`build_features_v2.py` has already **censored** — for a mover that column holds
the *previous* role's duration. The intended label, `is_mover`, sits unused in
the same table. Measured against it:

```
 is_mover | label_actual |  count
        0 |            0 | 307,865
        0 |            1 |  26,437   ← labelled mover, is not
        1 |            0 |  19,347   ← is a mover, labelled stayer
        1 |            1 |  16,878
```

Only 46.6% of true movers carry label 1, and 61% of positive labels are wrong.
The training target has 39% precision against the project's own definition.

### 1.3 Leakage, in both model families

**Classifier.** `recency_factor = 1/(1+current_duration)` and
`hist_flight_risk = current_duration/hist_avg` are arithmetic on current
tenure; the label is a threshold on current tenure. Measured mean
`recency_factor`: 0.0265 for label 0 versus 0.2994 for label 1. The docstring
at `train_rl_flight_risk.py:12` claims the opposite ("must NOT use
current_tenure_months directly").

**Survival.** `tenure_ratio`, `record_tenure_ratio` and
`seniority_stagnation_months` are all direct functions of `duration_months` —
which *is* the survival time they are scored against. `lgb_c_index: 0.983` in
`best_model_meta.json` is the leak, not skill.

### 1.4 Metric choice

Accuracy, on a ~6% positive rate. The "90% accuracy target" in the module
docstring is beaten by predicting that nobody ever moves. Ensemble weights are
set from test accuracy and the decision threshold is chosen on the test set, so
both headline figures are optimistically biased on top of the leak.

### 1.5 `train_flight_risk.py` trains on invented data

`generate_flight_risk_data` is `np.random.uniform`. The file prints a "Model
Performance" concordance index for a Cox model fitted to numbers it made up.
Nothing imports it; it is the file named after the task.

### 1.6 Nothing was actually being served

`ML_SCORING_URL` defaults to `localhost:8000`; production points it at
`http://retrieval:8000`, which has no `/score` route. `OutreachOrchestrator`
did not catch the resulting error, so a campaign died *after* paying for the
LLM screening run.

---

## 2. A correction to an earlier claim

`candidates_upgraded_time_machine` was initially assessed as "genuine observed
transitions — the only ground truth in the system", on the reading that its
12,826 rows were an earlier scrape. **That was wrong.**

Of 12,826 rows, **12,520 (97.6%)** have *both* `past_company` and `past_role`
exactly equal to the role at `role_index = 1` of the profile's current
experience list. It is a derived "previous employer" column, not a snapshot.
It contains no information that is not already in `experience`, and a model
trained against it would be learning to read the second line of its own input.

The real ground truth turned out to be better: the career history itself, once
it is on a calendar (§3.1).

---

## 3. What has been built

### 3.1 Calendar dates — `extract_career_dates.py`

`candidate_career_events.start_approx / end_approx` were declared in
`create_tables_v2.sql` and never written. Without dates there is no
point-in-time feature set, no calendar risk set, and no way to express
"moves within the next 12 months".

The dates were in the raw scrape the whole time. `parse_profiles_v2.py`
captured the duration line and read only the parenthesised duration out of it:

```
Apr 2016 → Mar 2020 (3 yrs 11 mos)
^^^^^^^^^^^^^^^^^^^^ discarded      ^^^^^^^^^^^^ kept
```

The extractor recovers them into a new table, `candidate_role_dates`. Nothing
existing is modified: `candidate_career_events` is untouched and the two are
joined by view rather than merged, so a bad parse cannot corrupt what is there.

Correctness is self-checking. The endpoints and the stated duration are parsed
from independent parts of the same line, so they can be cross-validated:

```
comparable pairs    3,381,241
  agree (±1 mo)     3,381,241 (100.00%)
  disagree (>3 mo)  0
impossible dates    future_start=0  end_before_start=0
```

Run `--verify` before anything consumes the output. Format census over the
corpus returns exactly twelve three-letter month abbreviations and nothing
else — no `Sept`, no localised or kanji dates.

### 3.2 The spell panel — `build_flight_risk_panel.py`

`flight_risk_spells`: one row per **employer** spell. Consecutive roles at the
same company are collapsed, because an internal promotion is not a flight
event and counting it as one produces a model that thinks promotion means
departure. Completed spells are observed events with exact durations; current
spells are right-censored at the scrape date.

**The leakage rule, stated structurally:**

> A feature may only read spells that **ended strictly before `spell_start`**.

Not "before the scrape", not "excluding the current role" — before the start of
the spell being predicted. The spell's own duration is the outcome and never
appears on the feature side. Elapsed tenure enters a model as the hazard
function's time index, never as a covariate.

`--check-leakage` enforces this empirically: it correlates every feature
against the outcome duration on completed spells and fails above |r| = 0.75.
It is the test that would have caught c-index 0.983 — `tenure_ratio` and
`recency_factor` would both sit near the ceiling.

### 3.3 Harm reduction

- `OutreachOrchestrator` now degrades to an unscored publish instead of
  discarding a completed screening run.
- `serve_models.py` refuses to start without `ALLOW_INSAMPLE_SCORER=1`.
- `best_model_meta.json` carries an `_INVALID` marker explaining the leak.
  Retained rather than deleted, so it stays auditable.
- `train_flight_risk.py` carries a QUARANTINED header.

---

## 4. Is flight risk different for Japanese candidates?

Yes, in two distinct ways — and the second matters more than the first.

**Level.** Japan's baseline tenure is much longer (1.82M profiles, 5+ yr careers):

| Market | n | avg hist. tenure | median | p90 | % avg ≥10yr/employer |
| --- | --- | --- | --- | --- | --- |
| **Japan** | 321,862 | **46.7 mo** | 45.0 | 123.5 | **10.7%** |
| Singapore | 361,339 | 36.1 | 32.0 | 86.0 | 5.2% |
| Other | 310,736 | 35.1 | 31.0 | 99.0 | 7.3% |
| Malaysia | 605,807 | 32.5 | 29.6 | — | — |
| Vietnam | 220,864 | 31.2 | 29.8 | 90.0 | 6.1% |

**Shape.** Mover rate by tenure-ratio bucket (current tenure ÷ own historical average):

| bucket | Japan | Singapore | Malaysia | Vietnam |
| --- | --- | --- | --- | --- |
| 1 (early) | 10.81% | 16.40% | 11.82% | 12.36% |
| 7 (late) | 5.57% | 6.75% | 4.14% | 4.13% |
| **spread** | **1.94×** | 2.43× | 2.85× | 2.99× |

The tenure-ratio feature carries roughly **half** the discriminative range in
Japan that it does in Vietnam or Malaysia. Japan's hazard curve is flatter.
This is an interaction, not an offset — a country dummy cannot absorb it. Japan
is ~18% of rows, so a pooled fit is outvoted and will over-trust hopping
signals for Japanese candidates.

### Three caveats that shape the design

1. **It is location, not nationality.** The market split comes from the
   location string. A Japanese national in Singapore reads as Singapore; a
   French expat in Tokyo reads as Japan. For flight risk this is the *correct*
   unit — tenure norms are a property of the labour market, not the passport.
   Modelling on inferred nationality would be both weaker and legally exposed.

2. **The variance inside Japan is probably larger than the gap between
   countries.** 終身雇用 remnants at large traditional employers versus 外資系
   and startups. Test employer-type segmentation before building anything
   Japan-specific.

3. **Mechanisms not yet captured.** 新卒一括採用 puts cohort intake on the
   April fiscal boundary and makes a first move at ~3 years a norm; job-hopping
   stigma means the same prior-employer count signals something different than
   it does in Singapore. `start_month` / `start_quarter` are in the panel for
   the first of these.

**So: not "Japanese people are more loyal."** Longer baseline tenure, a flatter
hazard response to the available features, and strong segmentation by employer
type.

**Design implication.** One shared model with a `market` term and explicit
market × tenure-feature interactions — not four separate models, and not a
nationality feature. Per-market isotonic calibration, per-market thresholds
from the recruiter's cost ratio, and segment-level metrics in every report.

---

## 5. Plan

**Phase 0 — harm reduction.** Done (§3.3).

**Phase 1 — ground truth.** Dates recovered and verified (§3.1); spell panel
built (§3.2). Remaining: **monthly snapshot capture**. An append-only
`candidate_snapshots` table (`profile_url, captured_at, current_company,
latest_role, tenure`) is the single highest-value item on this list. Six
monthly snapshots give ~2M person-months of genuinely prospective outcomes and
— unlike anything reconstructed from a single scrape — profile-update
behaviour. Nothing else here matters as much.

**Phase 2 — target and evaluation.** Discrete-time survival: P(leave in the
next 12 months | survived to t), on a person-quarter expansion of the spell
panel. Split by profile **and** by calendar time. Metrics: time-dependent AUC
and c-index for ranking, reliability curve and Brier for calibration,
precision@k for the workflow the recruiter actually has. Accuracy is not
reported. Baselines that must be beaten: constant; tenure alone; tenure versus
personal average. **If the model cannot beat the third, ship the third** — it
is free and explainable.

**Phase 3 — model.** Discrete-time logistic hazard with market-stratified
intercepts, or LightGBM with a binary-hazard objective on the person-period
table. Gradient boosting over Cox: the hazards are demonstrably
non-proportional (§4). Add employer-type segmentation from
`enriched_companies`. Features worth having that do not exist yet:
time-since-promotion from prior roles only, employer churn computed from the
panel (not the leaky `company_flight_risk`), title change without employer
change.

**Phase 4 — serving.** Load a versioned artefact; never train at import. Return
a calibrated probability, an explicit horizon, and a coverage flag. Retire the
100/10 encoding. Make `tenureMonths` real or remove it from the contract. Fix
`relevancy` to use the JD it is handed, or delete the field. Log every score
with its features and model version so it can be backtested.

**Phase 5 — monitoring.** Realised versus predicted move rate, per market, per
cohort. Only possible once snapshots accumulate, which is why Phase 1 gates
everything.

---

## 6. Expected performance

An honest 12-month-horizon AUC on résumé-only features lands around
**0.62–0.70**. The 0.98 is not a target to recover. Anyone reporting >0.85 on
this problem from résumé features has a leak.

The realistic win is precision@k — roughly doubling the base rate in the top 50,
which is what actually changes a recruiter's day.

**What no modelling change fixes:** résumés carry almost no signal about
*intent*. The real predictors are behavioural — profile-update velocity,
recruiter-message response, "open to work", compensation against market band,
manager change, employer layoffs or funding events. The snapshot pipeline in
Phase 1 delivers the first of those for free, and it is a bigger lift than
anything in Phase 3.
