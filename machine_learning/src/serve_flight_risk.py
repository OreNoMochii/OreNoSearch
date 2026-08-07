"""
Serve flight-risk scores from the frozen artifact.

Replaces serve_models.py, which fitted XGBoost at import time on the whole
feature table and then scored rows selected out of that same frame — every
score it returned was in-sample. This loads a versioned artifact and never
trains. If the artifact is absent it refuses to start rather than improvising
a model, because a scoring service that silently invents its own is how the
previous one went unnoticed for so long.

The contract, and what changed
------------------------------
The old response had four fields and three of them were fiction: `hazard` was
`100 if pred else 10`, `tenure` was the literal 24, and `relevancy` ignored
the jd_text it was handed. This returns what it can actually compute:

    move_prob       calibrated P(leaves current employer within horizon)
    horizon_months  what that probability is over — 12
    basis           "model" | "baseline" | "none"
    tenure_months   real elapsed tenure, or null
    market          labour market used for calibration

`basis` is the field that matters operationally. A recruiter reading 0.31 has
no way to know whether it came from a fitted model or a tenure lookup, and the
difference is large. Roughly a third of candidates have no usable prior
history and get "baseline"; anyone not in the panel at all gets "none" and a
null probability, not a made-up number.

Why a baseline fallback rather than a default constant
------------------------------------------------------
serve_models.py returned `move_prob: 0.05` for unknown candidates — a specific
number that looks like a prediction and is not one. B3, the empirical leave
rate at a given tenure, is a real estimate from real data for exactly the
population that lacks features. It is worse than the model and much better
than a constant, and `basis` says which one you got.

Usage
-----
    uvicorn serve_flight_risk:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

import lightgbm as lgb

load_dotenv(
    dotenv_path=os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
    )
)

ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts" / "flight_risk"


def db_config() -> dict:
    return dict(
        dbname=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5433"),
    )


# ── Artifact ────────────────────────────────────────────────────────────────

if not (ARTIFACT_DIR / "model.txt").exists():
    sys.exit(
        f"refusing to start: no artifact at {ARTIFACT_DIR}.\n"
        "Run train_flight_risk_model.py --train first. This service does not\n"
        "train its own model — that is what the version it replaced did wrong."
    )

BOOSTER = lgb.Booster(model_file=str(ARTIFACT_DIR / "model.txt"))
CALIBRATORS = joblib.load(ARTIFACT_DIR / "calibrators.joblib")
B3 = json.loads((ARTIFACT_DIR / "b3_hazard.json").read_text())
META = json.loads((ARTIFACT_DIR / "meta.json").read_text())
FEATURES: list[str] = META["features"]
HORIZON: int = META["horizon_months"]

print(f"loaded artifact  git={META['git_sha'][:8]}  created={META['created_at']}")
print(f"  features={len(FEATURES)}  horizon={HORIZON}mo  "
      f"val AUC={META['validation_metrics']['model_auc']:.4f} "
      f"(B3 {META['validation_metrics']['b3_auc']:.4f})")

app = FastAPI(title="Flight Risk Scoring")


# ── Candidate lookup ────────────────────────────────────────────────────────
#
# Scores the candidate's CURRENT spell. Prior-history features come straight
# from the panel, where they were computed under the rule that only spells
# ending before spell_start are visible — so the same anti-leakage guarantee
# that held in training holds here.
LOOKUP_SQL = f"""
SELECT
    s.profile_url,
    s.market,
    s.spell_start,
    s.company,
    {", ".join("s." + f for f in FEATURES if f not in ("elapsed_months", "obs_month"))}
FROM flight_risk_spells s
WHERE s.profile_url = ANY(%(urls)s)
  AND s.is_current
"""


def months_between(a: date, b: date) -> int:
    return (b.year - a.year) * 12 + (b.month - a.month)


def b3_predict(elapsed: np.ndarray) -> np.ndarray:
    buckets = np.digitize(np.asarray(elapsed, dtype=float), B3["edges"])
    return np.array([B3["rates"].get(str(int(b)), B3["prior"]) for b in buckets])


def calibrate(raw: np.ndarray, markets: list[str | None]) -> np.ndarray:
    """
    Per-market isotonic. Markets differ enough in base rate (Japan 0.161 vs
    Other 0.219) that one global curve would systematically mis-state the
    largest single population in this corpus.
    """
    out = np.empty(len(raw), dtype=float)
    for i, (r, mkt) in enumerate(zip(raw, markets)):
        iso = CALIBRATORS.get(mkt) or CALIBRATORS["__global__"]
        out[i] = float(iso.predict([r])[0])
    return out


class ScoreRequest(BaseModel):
    profile_urls: list[str]
    # Accepted and ignored, as it always was. Kept so the existing caller does
    # not break; relevance against a JD is the retrieval pipeline's job, not
    # this model's, and pretending otherwise is what the old `relevancy` field
    # did.
    jd_text: str = ""


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "artifact_git_sha": META["git_sha"],
        "created_at": META["created_at"],
        "horizon_months": HORIZON,
        "validation_auc": META["validation_metrics"]["model_auc"],
        "b3_auc": META["validation_metrics"]["b3_auc"],
    }


@app.post("/score")
def score(req: ScoreRequest) -> dict:
    if not req.profile_urls:
        return {"scored_candidates": {}}

    conn = psycopg2.connect(**db_config())
    try:
        rows = pd.read_sql(LOOKUP_SQL, conn, params={"urls": list(req.profile_urls)})
    finally:
        conn.close()

    results: dict[str, dict] = {}
    today = date.today()

    if not rows.empty:
        rows["elapsed_months"] = [
            max(0, months_between(sd, today)) for sd in rows["spell_start"]
        ]
        rows["obs_month"] = today.month

        # A candidate with no prior employment history has nulls across every
        # prior_* feature. The model would still emit a number, but it would
        # be extrapolating past its training distribution, so those go to B3.
        prior_cols = [f for f in FEATURES if f.startswith("prior_")]
        has_history = rows[prior_cols].notna().any(axis=1) & rows["prior_n_employers"].fillna(0).gt(0)

        raw = BOOSTER.predict(rows[FEATURES])
        cal = calibrate(np.asarray(raw, dtype=float), list(rows["market"]))
        fallback = b3_predict(rows["elapsed_months"].to_numpy())

        for i, r in enumerate(rows.itertuples()):
            model_ok = bool(has_history.iloc[i])
            results[r.profile_url] = {
                "move_prob": round(float(cal[i] if model_ok else fallback[i]), 6),
                "horizon_months": HORIZON,
                "basis": "model" if model_ok else "baseline",
                "tenure_months": int(r.elapsed_months),
                "market": r.market,
            }

    # Not in the panel at all — no current spell on record. Returns null rather
    # than a number. The previous service answered 0.05 here, which is a
    # prediction-shaped object with no prediction in it.
    for url in req.profile_urls:
        results.setdefault(url, {
            "move_prob": None,
            "horizon_months": HORIZON,
            "basis": "none",
            "tenure_months": None,
            "market": None,
        })

    return {"scored_candidates": results}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
