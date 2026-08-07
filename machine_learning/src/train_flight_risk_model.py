"""
Train and freeze the deployable flight-risk artifact.

This is the piece that did not exist. `eval_flight_risk.py` refits LightGBM on
every invocation to answer "is this worth building" — it never saved anything,
so there has been nothing for HttpRiskScorer to point at. This produces a
versioned artifact on disk and nothing else. It does not serve, and it does
not decide policy.

What goes in the artifact, and why each piece
---------------------------------------------
  model.txt         LightGBM discrete-time hazard, P(leaves within 12 months
                    | still there at t).

  b3_hazard.json    The empirical leave rate per tenure bucket. Carried
                    deliberately, for two reasons. It is the coverage fallback
                    when a candidate has no usable prior history — roughly a
                    third of the corpus — and shipping a real number for them
                    beats shipping nothing or a fabricated one. And it is the
                    honesty check: the model is only worth its serving cost
                    while it beats this, and keeping them side by side in the
                    same file makes that comparison impossible to quietly drop.

  calibrators/      Per-market isotonic regression. The raw LightGBM score
                    ranks well and is not a probability. Markets have
                    materially different base rates (Japan 0.161 vs Other
                    0.219 on the calendar split), so one global calibrator
                    would leave Japanese candidates systematically
                    mis-stated — which is exactly the population this corpus
                    is heaviest in.

  meta.json         Feature list, metrics, row counts, git SHA, data
                    fingerprint. A model whose training data cannot be
                    identified later is not reproducible, and this subsystem
                    has already shipped one set of numbers nobody could trace.

Two deliberate choices
----------------------
Validation and the shipped fit are separate. Metrics come from a calendar
split — train before the cutoff, test after — because that is the honest
estimate of future performance. The artifact is then refit on ALL the data,
including the test period, because withholding recent years from the model you
actually deploy costs accuracy for no benefit. The reported metrics describe
the held-out fit, not the shipped one, and meta.json says so.

`foreign_affinity` is not a feature. Measured at +0.0004 AUC — see
docs/flight_risk.md §7. The company_foreign_affinity table remains useful for
describing a shortlist, but it is not a predictor and does not belong here.

Usage
-----
    python -m machine_learning.src.train_flight_risk_model --train
    python -m machine_learning.src.train_flight_risk_model --train --sample 200000
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score, brier_score_loss

import lightgbm as lgb

from build_flight_risk_panel import FEATURES
from eval_flight_risk import (
    PANEL_SQL, db_config, panel_params, HORIZON_MONTHS, PERIOD_MONTHS,
)

load_dotenv(
    dotenv_path=os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
    )
)

ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts" / "flight_risk"

# The frozen contract. Deliberately not FEATURES + everything available:
# elapsed_months is the hazard's time index and obs_month carries the April
# fiscal-year effect. foreign_affinity is excluded on measured evidence.
MODEL_FEATURES = FEATURES + ["elapsed_months", "obs_month"]

# Same buckets as the eval harness so the two are comparable.
B3_EDGES = [0, 6, 12, 18, 24, 36, 48, 60, 84, 120, 180, 10_000]

LGB_PARAMS = dict(
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


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        return "unknown"


def load_panel(sample: int) -> pd.DataFrame:
    conn = psycopg2.connect(**db_config())
    try:
        params = panel_params(conn, sample)
        print(f"expanding ~{sample:,} spells (1 in {params['bucket_mod']}) "
              "into person-periods…")
        df = pd.read_sql(PANEL_SQL, conn, params=params)
    finally:
        conn.close()
    df["obs_date"] = pd.to_datetime(df["obs_date"])
    print(f"  {len(df):,} person-periods, base rate {df['y'].mean():.4f}")
    return df


def fit_b3(df: pd.DataFrame) -> dict:
    """
    Empirical hazard per tenure bucket, shrunk toward the global rate.

    Small buckets at 15+ years of tenure hold a handful of observations; the
    shrinkage stops those becoming confident nonsense.
    """
    prior = float(df["y"].mean())
    buckets = np.digitize(df["elapsed_months"].to_numpy(dtype=float), B3_EDGES)
    table = {}
    for b in np.unique(buckets):
        m = buckets == b
        n = int(m.sum())
        table[int(b)] = float((df["y"].to_numpy()[m].sum() + 20 * prior) / (n + 20))
    return {"edges": B3_EDGES, "rates": table, "prior": prior}


def b3_predict(b3: dict, elapsed: np.ndarray) -> np.ndarray:
    buckets = np.digitize(np.asarray(elapsed, dtype=float), b3["edges"])
    return np.array([b3["rates"].get(int(b), b3["prior"]) for b in buckets])


def train(sample: int, cutoff: str, train_frac: float) -> int:
    df = load_panel(sample)
    if df.empty:
        print("panel is empty — run build_flight_risk_panel.py --build first.")
        return 1

    # ── Validation fit: calendar split ───────────────────────────────────
    #
    # The cutoff is chosen by quantile, not by calendar date. A hardcoded
    # 2016-01-01 put 27% of person-periods in train and 73% in test: the panel
    # is heavily weighted toward recent spells, so a date that looks like it
    # sits two-thirds of the way through the corpus does not. That starved the
    # fit — early stopping fired at 17 rounds — and those 17 rounds were then
    # reused to refit on 3.75x as much data, underfitting the shipped model.
    #
    # Taking the date AT the desired quantile keeps the split a genuine
    # train-on-past/test-on-future while guaranteeing the training side is
    # actually the larger one.
    if cutoff == "auto":
        cut = df["obs_date"].quantile(train_frac)
        print(f"cutoff auto-selected at the {train_frac:.0%} quantile: {cut.date()}")
    else:
        cut = pd.Timestamp(cutoff)

    tr = df[df["obs_date"] < cut]
    te = df[df["obs_date"] >= cut]
    if len(te) == 0 or te["y"].nunique() < 2:
        print(f"no usable test fold at cutoff {cutoff}")
        return 1

    ratio = len(tr) / max(1, len(te))
    print(f"\nvalidation split: train {len(tr):,} | test {len(te):,} "
          f"(cutoff {pd.Timestamp(cut).date()}, ratio {ratio:.2f}, "
          f"test base rate {te['y'].mean():.4f})")
    if ratio < 1.0:
        print(f"  WARNING train fold is smaller than test ({ratio:.2f}). Early "
              "stopping will pick too few rounds and the refit will underfit.")

    dtrain = lgb.Dataset(tr[MODEL_FEATURES], label=tr["y"])
    dvalid = lgb.Dataset(te[MODEL_FEATURES], label=te["y"], reference=dtrain)
    booster = lgb.train(
        LGB_PARAMS, dtrain, num_boost_round=800, valid_sets=[dvalid],
        callbacks=[lgb.early_stopping(50, verbose=False)],
    )
    best_rounds = booster.best_iteration
    raw = booster.predict(te[MODEL_FEATURES], num_iteration=best_rounds)

    b3_val = fit_b3(tr)
    b3_pred = b3_predict(b3_val, te["elapsed_months"].to_numpy())

    y_te = te["y"].to_numpy()
    auc_model = roc_auc_score(y_te, raw)
    auc_b3 = roc_auc_score(y_te, b3_pred)

    def p_at(score, k):
        n = max(1, int(len(y_te) * k))
        return float(y_te[np.argsort(-score)[:n]].mean())

    metrics = {
        "split": "calendar",
        "cutoff": str(pd.Timestamp(cut).date()),
        "cutoff_mode": cutoff,
        "train_test_ratio": float(len(tr) / max(1, len(te))),
        "test_rows": int(len(te)),
        "test_base_rate": float(y_te.mean()),
        "model_auc": float(auc_model),
        "b3_auc": float(auc_b3),
        "auc_gain_over_b3": float(auc_model - auc_b3),
        "model_p_at_5pct": p_at(raw, 0.05),
        "b3_p_at_5pct": p_at(b3_pred, 0.05),
        "model_brier_uncalibrated": float(brier_score_loss(y_te, raw)),
        "best_rounds": int(best_rounds),
    }
    print(f"  model AUC {auc_model:.4f} | B3 AUC {auc_b3:.4f} "
          f"| gain {auc_model - auc_b3:+.4f}")
    print(f"  model p@5% {metrics['model_p_at_5pct']:.4f} "
          f"| B3 p@5% {metrics['b3_p_at_5pct']:.4f}")

    # ── Per-market calibration, fitted on the held-out fold ──────────────
    # Fitting these on the training fold would calibrate against predictions
    # the model has already seen, which is how a confidently wrong probability
    # gets shipped.
    calibrators = {}
    per_market = {}
    for mkt in sorted(te["market"].dropna().unique()):
        m = (te["market"] == mkt).to_numpy()
        if m.sum() < 500 or len(np.unique(y_te[m])) < 2:
            print(f"  {mkt}: too few rows to calibrate, will fall back to global")
            continue
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(raw[m], y_te[m])
        calibrators[mkt] = iso
        per_market[mkt] = {
            "n": int(m.sum()),
            "base_rate": float(y_te[m].mean()),
            "auc": float(roc_auc_score(y_te[m], raw[m])),
            "brier_raw": float(brier_score_loss(y_te[m], raw[m])),
            "brier_calibrated": float(brier_score_loss(y_te[m], iso.predict(raw[m]))),
        }
        print(f"  {mkt:<10} n={m.sum():>8,} base={y_te[m].mean():.4f} "
              f"auc={per_market[mkt]['auc']:.4f} "
              f"brier {per_market[mkt]['brier_raw']:.4f} → "
              f"{per_market[mkt]['brier_calibrated']:.4f}")

    iso_global = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    iso_global.fit(raw, y_te)
    calibrators["__global__"] = iso_global

    # ── Shipped fit: all data ────────────────────────────────────────────
    # Refit on everything, at the round count the validation fit settled on.
    # Early stopping needs a holdout; reusing the fixed count avoids either
    # withholding data from the shipped model or tuning against its own
    # training set.
    print(f"\nrefitting on all {len(df):,} rows at {best_rounds} rounds…")
    final = lgb.train(
        LGB_PARAMS, lgb.Dataset(df[MODEL_FEATURES], label=df["y"]),
        num_boost_round=best_rounds,
    )
    b3_final = fit_b3(df)

    # ── Write ────────────────────────────────────────────────────────────
    import joblib

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    final.save_model(str(ARTIFACT_DIR / "model.txt"))
    joblib.dump(calibrators, ARTIFACT_DIR / "calibrators.joblib")
    (ARTIFACT_DIR / "b3_hazard.json").write_text(json.dumps(b3_final, indent=2))

    meta = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "git_sha": git_sha(),
        "features": MODEL_FEATURES,
        "horizon_months": HORIZON_MONTHS,
        "period_months": PERIOD_MONTHS,
        "spells_sampled": sample,
        "person_periods_total": int(len(df)),
        "person_periods_train": int(len(tr)),
        "base_rate_overall": float(df["y"].mean()),
        # These describe the CALENDAR-SPLIT fit, not the shipped one. The
        # shipped model saw the test period and cannot be scored on it.
        "validation_metrics": metrics,
        "per_market": per_market,
        "excluded_features": {
            "foreign_affinity": "+0.0004 AUC, see docs/flight_risk.md §7",
            "n_internal_roles": "counted over whole spell; post-prediction info",
            "start_year": "observation-window bias, not signal",
        },
        "notes": (
            "Trained on reconstructed career history, not observed transitions. "
            "No prospective validation exists until candidate_snapshots holds a "
            "second capture."
        ),
    }
    (ARTIFACT_DIR / "meta.json").write_text(json.dumps(meta, indent=2))

    print(f"\nwrote artifact to {ARTIFACT_DIR}")
    for f in sorted(ARTIFACT_DIR.iterdir()):
        print(f"  {f.name:<22} {f.stat().st_size:>10,} bytes")

    if metrics["auc_gain_over_b3"] < 0.01:
        print(
            f"\nWARNING gain over B3 is only {metrics['auc_gain_over_b3']:+.4f}.\n"
            "  B3 is a lookup table needing no features and no retraining. At\n"
            "  this margin the model's case rests on precision@k, not ranking\n"
            "  quality — check model_p_at_5pct against b3_p_at_5pct before\n"
            "  committing to the serving infrastructure."
        )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--train", action="store_true")
    ap.add_argument("--sample", type=int, default=100_000)
    ap.add_argument("--cutoff", type=str, default="auto",
                    help="'auto' picks the date at --train-frac quantile of obs_date, "
                         "or pass an explicit YYYY-MM-DD")
    ap.add_argument("--train-frac", type=float, default=0.70,
                    help="target share of person-periods in the training fold")
    args = ap.parse_args()
    if not args.train:
        ap.print_help()
        return 2
    return train(args.sample, args.cutoff, args.train_frac)


if __name__ == "__main__":
    raise SystemExit(main())
