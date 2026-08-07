"""
Honest evaluation of flight-risk prediction, with the baselines that matter.

The question this answers
-------------------------
Not "how high can the number go" — the previous generation of this pipeline
answered that with c-index 0.983 by handing the model its own target. The
question is whether anything learned from résumé features beats the two
trivial rules a recruiter could apply with no model at all:

  B1  elapsed tenure alone
  B2  elapsed tenure against the person's own historical average

If the LightGBM model cannot beat B2, **ship B2**. It is free, it is
explainable to a recruiter, and it cannot rot. Reporting a model that ties its
own baseline as a success is how the last version of this got to production.

Target
------
Discrete-time hazard on the spell panel. At each observation point t months
into a spell, predict whether the person leaves within the next 12 months:

    duration - t  > 12          → y = 0   (still there a year later)
    duration - t <= 12, event=1 → y = 1   (observed to leave inside the year)
    duration - t <= 12, event=0 → dropped (censored; the outcome is unknown)

That third case is the one that must not be quietly filled in with 0. A
current spell tells you the person had not left *by the scrape*, not that they
stayed a further year. Counting those as stayers is a slow, invisible way to
manufacture optimism, and it biases hardest against exactly the long-tenure
Japanese profiles this corpus is full of.

Splits
------
Both are reported, because they fail differently:

  by profile   the same person's spells never straddle train and test.
               Catches memorising a career.
  by calendar  train on observation points before a cutoff, test after.
               Catches a model that only works on the era it was fitted to.
               This is the harder test and the one that matters for
               deployment.

Features are whatever `build_flight_risk_panel.FEATURES` allows, plus elapsed
tenure — which enters here as the hazard's time index, the one place it is
legitimate. It is never a covariate describing the person.

Usage
-----
    python -m machine_learning.src.eval_flight_risk --sample 200000
    python -m machine_learning.src.eval_flight_risk --sample 200000 --by-market
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from sklearn.metrics import roc_auc_score, brier_score_loss

try:
    import lightgbm as lgb
except ImportError:  # the baselines still run without it
    lgb = None

from build_flight_risk_panel import FEATURES  # the leakage-audited contract

load_dotenv(
    dotenv_path=os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
    )
)

HORIZON_MONTHS = 12
PERIOD_MONTHS = 3          # quarterly observation points
MAX_ELAPSED_MONTHS = 240   # 20 years; beyond this the periods are noise


def db_config() -> dict:
    return dict(
        dbname=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5433"),
    )


# The expansion runs in Postgres. Emitting person-periods in Python would mean
# shipping every spell over the wire and then multiplying it by ~20.
PANEL_SQL = f"""
WITH sampled AS (
    SELECT *
    FROM flight_risk_spells
    WHERE duration_months >= 3
      AND prior_n_employers >= 1        -- needs some history to have features
      AND spell_start >= DATE '1995-01-01'
      -- Deterministic pseudo-random sample by hash bucket.
      --
      -- This was `ORDER BY md5(profile_url) LIMIT n`, which is correct but
      -- sorts all 19.5M qualifying spells before discarding almost all of
      -- them. On NVMe that was tolerable; once the database moved to an
      -- external HDD it became the dominant cost of every run — a top-N sort
      -- spilling to disk.
      --
      -- A hash-bucket filter keeps the properties that mattered (stable
      -- across runs, uncorrelated with anything in the data, a whole profile
      -- kept together) and needs no sort. 28 bits rather than 32 so the value
      -- is always positive — bit(32)::int is signed, and a negative modulus
      -- in Postgres yields a negative remainder.
      AND ('x' || substr(md5(profile_url), 1, 7))::bit(28)::int
          %% %(bucket_mod)s = 0
    LIMIT %(sample)s
)
SELECT
    s.profile_url,
    s.market,
    g.t                                                   AS elapsed_months,
    (s.spell_start + (g.t || ' months')::interval)::date  AS obs_date,
    EXTRACT(MONTH FROM (s.spell_start + (g.t || ' months')::interval))::int
                                                          AS obs_month,
    CASE WHEN s.duration_months - g.t > {HORIZON_MONTHS} THEN 0 ELSE 1 END AS y,
    -- Employer's position on the 外資系 / domestic axis. NULL for ~2/3 of
    -- companies (below the evidence gate in company_foreign_affinity);
    -- LightGBM takes NaN natively, so no imputation is invented here.
    cfa.foreign_affinity,
    {", ".join("s." + f for f in FEATURES)}
FROM sampled s
LEFT JOIN company_norm_map cnm         ON cnm.company = s.company
LEFT JOIN company_foreign_affinity cfa ON cfa.norm    = cnm.norm
CROSS JOIN LATERAL generate_series(
    0,
    LEAST(s.duration_months, {MAX_ELAPSED_MONTHS})::int - 1,
    {PERIOD_MONTHS}
) AS g(t)
WHERE
    -- Keep the period only if the 12-month outcome is actually knowable.
    -- Censored spells whose window runs past the scrape are dropped, not
    -- assumed to be stayers.
    s.duration_months - g.t > {HORIZON_MONTHS}
    OR s.event = 1
"""


def panel_params(conn, sample: int) -> dict:
    """
    Sample size plus the hash modulus that yields roughly that many spells.

    Read from reltuples rather than count(*) — a planner estimate is accurate
    enough to size a sample and does not cost a full scan of 19.5M rows on a
    spinning disk.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT GREATEST(reltuples::bigint, 1) FROM pg_class "
            "WHERE relname = 'flight_risk_spells'"
        )
        row = cur.fetchone()
    total = int(row[0]) if row else sample
    # LIMIT still caps the result, so overshooting slightly is harmless;
    # undershooting would silently shrink the sample, so bias low.
    mod = max(1, int(total / max(sample, 1)))
    return {"sample": sample, "bucket_mod": mod}


def load(sample: int) -> pd.DataFrame:
    conn = psycopg2.connect(**db_config())
    try:
        params = panel_params(conn, sample)
        print(f"expanding ~{sample:,} spells (1 in {params['bucket_mod']}) "
              "into quarterly person-periods…")
        df = pd.read_sql(PANEL_SQL, conn, params=params)
    finally:
        conn.close()

    df["obs_date"] = pd.to_datetime(df["obs_date"])
    print(f"  {len(df):,} person-periods, base rate {df['y'].mean():.4f}")
    return df


# ─────────────────────────────────────────────────────────────────────────────
# Baselines
# ─────────────────────────────────────────────────────────────────────────────

def baseline_scores(tr: pd.DataFrame, te: pd.DataFrame) -> dict[str, np.ndarray]:
    """
    The rules a recruiter could apply unaided. The model has to beat these.

    On the sign
    -----------
    These were first written as "longer tenure ⇒ riskier", which is the
    intuition the phrase "flight risk" invites. Measured, both scored *below*
    0.5 (B1 at 0.349, B2 at 0.428) — they are anti-predictive in that
    direction. The hazard of leaving a job has strong negative duration
    dependence: it peaks early and decays. Someone eight months in is far
    likelier to move within the year than someone ten years in.

    So they are signed the other way here. This matters more than it sounds:
    a backwards baseline is a free 0.15 AUC of apparent model skill, and
    getting it wrong would have reproduced in miniature exactly the flattery
    this whole rebuild exists to remove.

    B1/B2 are monotone rankings, not probabilities, so Brier is not reported
    for them. B3 is a real probability and is scored on both.
    """
    out: dict[str, np.ndarray] = {}

    elapsed_te = te["elapsed_months"].to_numpy(dtype=float)
    prior_avg_te = te["prior_avg_tenure"].to_numpy(dtype=float)

    # B1 — time served, inverted. The single most obvious rule.
    out["B1 -tenure"] = -elapsed_te

    # B2 — time served against how long this person usually stays, inverted.
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(prior_avg_te > 0, elapsed_te / prior_avg_te, 0.0)
    out["B2 -tenure/personal avg"] = -np.nan_to_num(ratio, nan=0.0, posinf=0.0)

    # B3 — the empirical hazard curve: the observed leave rate at each tenure
    # bucket, fitted on train and looked up on test. No candidate features at
    # all, just "what usually happens to someone this far into a job".
    #
    # This is the honest bar. B1 and B2 are monotone and so cannot express a
    # hazard that rises then falls; B3 can, which makes it strictly the
    # stronger no-features rule. If the model does not clear B3 by a margin
    # worth maintaining, the résumé features are not earning their keep.
    edges = np.array([0, 6, 12, 18, 24, 36, 48, 60, 84, 120, 180, 10_000])
    tr_bucket = np.digitize(tr["elapsed_months"].to_numpy(dtype=float), edges)
    te_bucket = np.digitize(elapsed_te, edges)
    prior = tr["y"].mean()
    rates = {}
    for b in np.unique(tr_bucket):
        m = tr_bucket == b
        n = int(m.sum())
        # Shrink small buckets toward the overall rate rather than trusting
        # a handful of observations at 15+ years of tenure.
        rates[b] = (tr["y"].to_numpy()[m].sum() + 20 * prior) / (n + 20)
    out["B3 empirical hazard(t)"] = np.array([rates.get(b, prior) for b in te_bucket])

    return out


def precision_at_k(y: np.ndarray, score: np.ndarray, k_frac: float) -> float:
    n = max(1, int(len(y) * k_frac))
    idx = np.argsort(-score)[:n]
    return float(y[idx].mean())


def evaluate(
    name: str, y: np.ndarray, score: np.ndarray, base_rate: float, proba: bool
) -> dict:
    auc = roc_auc_score(y, score)
    p5 = precision_at_k(y, score, 0.05)
    p10 = precision_at_k(y, score, 0.10)
    return {
        "model": name,
        "auc": auc,
        "brier": brier_score_loss(y, score) if proba else np.nan,
        "p@5%": p5,
        "lift@5%": p5 / base_rate if base_rate else np.nan,
        "p@10%": p10,
        "lift@10%": p10 / base_rate if base_rate else np.nan,
    }


def fit_lgbm(tr: pd.DataFrame, te: pd.DataFrame, cols: list[str]) -> np.ndarray | None:
    if lgb is None:
        print("  (lightgbm not installed — model skipped, baselines only)")
        return None
    train = lgb.Dataset(tr[cols], label=tr["y"])
    valid = lgb.Dataset(te[cols], label=te["y"], reference=train)
    params = dict(
        objective="binary",
        metric="auc",
        learning_rate=0.05,
        num_leaves=63,
        min_data_in_leaf=200,
        feature_fraction=0.9,
        bagging_fraction=0.8,
        bagging_freq=1,
        verbose=-1,
        seed=42,
    )
    booster = lgb.train(
        params,
        train,
        num_boost_round=600,
        valid_sets=[valid],
        callbacks=[lgb.early_stopping(50, verbose=False)],
    )
    return booster.predict(te[cols], num_iteration=booster.best_iteration)


def report(rows: list[dict], title: str) -> None:
    print(f"\n{title}")
    hdr = f"  {'model':<44}{'AUC':>8}{'Brier':>9}{'p@5%':>9}{'lift':>7}{'p@10%':>9}{'lift':>7}"
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for r in rows:
        brier = f"{r['brier']:.4f}" if not np.isnan(r["brier"]) else "     — "
        print(
            f"  {r['model']:<44}{r['auc']:>8.4f}{brier:>9}"
            f"{r['p@5%']:>9.4f}{r['lift@5%']:>7.2f}"
            f"{r['p@10%']:>9.4f}{r['lift@10%']:>7.2f}"
        )


def run_split(df: pd.DataFrame, tr_mask: np.ndarray, title: str, by_market: bool) -> None:
    tr, te = df[tr_mask], df[~tr_mask]
    if len(te) == 0 or te["y"].nunique() < 2:
        print(f"\n{title}: test fold is empty or single-class — skipped.")
        return

    base = te["y"].mean()
    print(f"\n{title}")
    print(f"  train {len(tr):,} | test {len(te):,} | test base rate {base:.4f}")

    # `foreign_affinity` is added here rather than to build_flight_risk_panel's
    # FEATURES because it is not a column of the spell panel — it is joined in
    # per employer, and the panel's leakage gate can only audit its own table.
    #
    # It carries a leakage caveat the gate would not catch either. The
    # co-employment graph behind it is built over the WHOLE corpus, test period
    # included, so on the calendar split it is mildly transductive: a company's
    # score is informed by moves that happen after the training cutoff. The
    # quantity is a stable structural attribute of an employer rather than
    # anything derived from an individual's outcome, so the channel is weak —
    # but it is not zero, and any gain here should be read as an upper bound
    # until the graph is rebuilt on pre-cutoff data only.
    cols = FEATURES + ["elapsed_months", "obs_month", "foreign_affinity"]
    bases = baseline_scores(tr, te)
    rows = []
    for nm, sc in bases.items():
        rows.append(
            evaluate(nm, te["y"].to_numpy(), sc, base, proba=nm.startswith("B3"))
        )

    # Looked up by name, not by position. `rows[-1]` happened to be B3 only
    # because baseline_scores() inserts it last, which is a property of a dict
    # literal and not something the comparison should depend on.
    b3_auc = next(r["auc"] for r in rows if r["model"].startswith("B3"))

    # Ablation. The point of running both is that "we built it, so use it" is
    # how a feature that does nothing ends up in production. The résumé-only
    # fit is the incumbent; foreign_affinity has to beat it on its own numbers.
    base_cols = [c for c in cols if c != "foreign_affinity"]
    pred_base = fit_lgbm(tr, te, base_cols)
    if pred_base is not None:
        r = evaluate("LightGBM (no affinity)", te["y"].to_numpy(), pred_base, base, proba=True)
        r["model"] = f"LightGBM (no affinity) ({r['auc'] - b3_auc:+.4f} vs B3)"
        rows.append(r)

    pred = fit_lgbm(tr, te, cols)
    if pred is not None:
        r = evaluate("LightGBM + affinity", te["y"].to_numpy(), pred, base, proba=True)
        delta = r["auc"] - (rows[-1]["auc"] if pred_base is not None else b3_auc)
        r["model"] = f"LightGBM + affinity ({delta:+.4f} vs no-affinity)"
        rows.append(r)

    report(rows, f"  results — {title}")

    if pred is not None and by_market:
        print("\n  by market (LightGBM vs B3, the baseline to beat)")
        hdr = f"    {'market':<11}{'n':>10}{'base':>8}{'B3 AUC':>9}{'LGB AUC':>9}{'Δ':>8}"
        print(hdr)
        print("    " + "-" * (len(hdr) - 4))
        b2_all = bases["B3 empirical hazard(t)"]
        for mkt in sorted(te["market"].unique()):
            m = (te["market"] == mkt).to_numpy()
            ym = te["y"].to_numpy()[m]
            # Need both classes present, and enough positives that the AUC
            # means anything.
            if len(np.unique(ym)) < 2 or ym.sum() < 50:
                continue
            a_b2 = roc_auc_score(ym, b2_all[m])
            a_lgb = roc_auc_score(ym, pred[m])
            print(
                f"    {mkt:<11}{m.sum():>10,}{ym.mean():>8.4f}"
                f"{a_b2:>9.4f}{a_lgb:>9.4f}{a_lgb - a_b2:>+8.4f}"
            )

        # Employer type, the hypothesis from the audit: that the 外資系 /
        # domestic split matters more than the country term. Asserted there on
        # descriptive statistics alone and never tested. This is the test.
        #
        # Read the `base` column first, not the AUCs. If the 12-month leave
        # rate genuinely differs across affinity bands, the feature is carrying
        # real segmentation regardless of what it does to a global AUC — and
        # if the bands have near-identical base rates, no amount of AUC
        # movement makes the hypothesis true.
        aff = te["foreign_affinity"].to_numpy(dtype=float)
        bands = [
            ("domestic  <0.25", aff < 0.25),
            ("mid  0.25-0.60", (aff >= 0.25) & (aff < 0.60)),
            ("foreign  >=0.60", aff >= 0.60),
            ("unscored  NULL", np.isnan(aff)),
        ]
        print("\n  by employer type (foreign_affinity band)")
        hdr2 = f"    {'band':<17}{'n':>10}{'base':>8}{'B3 AUC':>9}{'LGB AUC':>9}{'Δ':>8}"
        print(hdr2)
        print("    " + "-" * (len(hdr2) - 4))
        for label, m in bands:
            ym = te["y"].to_numpy()[m]
            if len(ym) == 0 or len(np.unique(ym)) < 2 or ym.sum() < 50:
                print(f"    {label:<17}{m.sum():>10,}{'too few':>26}")
                continue
            print(
                f"    {label:<17}{m.sum():>10,}{ym.mean():>8.4f}"
                f"{roc_auc_score(ym, b2_all[m]):>9.4f}"
                f"{roc_auc_score(ym, pred[m]):>9.4f}"
                f"{roc_auc_score(ym, pred[m]) - roc_auc_score(ym, b2_all[m]):>+8.4f}"
            )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sample", type=int, default=200_000, help="spells to expand")
    ap.add_argument("--cutoff", type=str, default="2016-01-01", help="calendar split date")
    ap.add_argument("--by-market", action="store_true", help="per-market breakdown")
    args = ap.parse_args()

    df = load(args.sample)
    if df.empty:
        print("panel is empty — run build_flight_risk_panel.py --build first.")
        return 1

    # Split 1 — by profile. The same career never straddles the boundary.
    h = pd.util.hash_pandas_object(df["profile_url"], index=False).to_numpy()
    run_split(df, (h % 100) < 70, "SPLIT A — by profile (70/30)", args.by_market)

    # Split 2 — by calendar. Fit on the past, tested on the future.
    cutoff = pd.Timestamp(args.cutoff)
    run_split(
        df,
        (df["obs_date"] < cutoff).to_numpy(),
        f"SPLIT B — by calendar (train < {args.cutoff})",
        args.by_market,
    )

    print(
        "\nRead SPLIT B, not SPLIT A. A model that only wins on the profile split\n"
        "has learned the era, not the behaviour. And if LightGBM does not clear\n"
        "B3 by a margin worth maintaining, ship B3 — it is a lookup table on\n"
        "tenure, needs no features, and cannot rot."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
