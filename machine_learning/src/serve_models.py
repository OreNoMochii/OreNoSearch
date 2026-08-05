from fastapi import FastAPI
from pydantic import BaseModel
import psycopg2
import pandas as pd
import numpy as np
import uvicorn
import xgboost as xgb

app = FastAPI(title="Advanced ML Scoring Pipeline API")

print("Initializing RL Flight Risk service...")

DB_CONFIG = dict(
    host="localhost", database="metaview_scraper",
    user="scraper_user", password="scraper_password", port="5433"
)

# Train the model on startup!
def train_model():
    print("Training XGBoost ensemble model on startup...")
    conn = psycopg2.connect(**DB_CONFIG)
    df = pd.read_sql("""
        SELECT 
            profile_url, hist_num_jobs, hist_avg_tenure, hist_median_tenure,
            hist_std_tenure, hist_min_tenure, hist_max_tenure, hist_total_duration,
            hist_flight_risk, tenure_cv, seniority_trajectory, hopping_frequency,
            pct_short_stints, recency_factor, semantic_drift_score,
            num_tech_skills, num_domain_skills, label_actual as label
        FROM candidates_rl_features
    """, conn)
    conn.close()
    
    if len(df) == 0:
        print("No data in candidates_rl_features!")
        return None
        
    feature_cols = [
        'hist_num_jobs', 'hist_avg_tenure', 'hist_median_tenure',
        'hist_std_tenure', 'hist_min_tenure', 'hist_max_tenure', 'hist_total_duration',
        'hist_flight_risk', 'tenure_cv', 'seniority_trajectory', 'hopping_frequency',
        'pct_short_stints', 'recency_factor', 'semantic_drift_score',
        'num_tech_skills', 'num_domain_skills'
    ]
    
    X = df[feature_cols].fillna(0)
    y = df['label'].fillna(0)
    
    neg = (y == 0).sum()
    pos = (y == 1).sum()
    scale_pos_weight = neg / pos if pos > 0 else 1
    
    model = xgb.XGBClassifier(
        n_estimators=100, # smaller for fast startup
        max_depth=6,
        learning_rate=0.1,
        scale_pos_weight=scale_pos_weight,
        random_state=42,
        eval_metric='logloss',
    )
    
    model.fit(X, y, verbose=False)

    # Index by profile_url so /score is a hash lookup rather than a full-frame
    # scan. drop=False keeps the column addressable for the response.
    df = df.set_index('profile_url', drop=False)
    df.index.name = 'profile_url_idx'

    print("Model trained successfully!")
    return model, df, feature_cols

model_data = train_model()

class ScoreRequest(BaseModel):
    profile_urls: list[str]
    jd_text: str = ""

@app.post("/score")
def score_candidates(req: ScoreRequest):
    """
    Score a set of candidates for attrition risk.

    Two things used to make this scale with the size of the feature table
    rather than the size of the request:

      1. `df['profile_url'].isin(req.profile_urls)` built a boolean mask over
         every row in candidates_rl_features on each call — O(total_rows), not
         O(requested).
      2. `for i, row in req_df.reset_index().iterrows()` materialised a pandas
         Series per candidate, which is roughly two orders of magnitude slower
         than working on the underlying arrays.

    The frame is now indexed by profile_url at startup, so selection is a hash
    join, and the response is assembled from numpy arrays.
    """
    if not req.profile_urls or not model_data:
        return {"scored_candidates": {}}

    model, df, feature_cols = model_data

    # Hash-join against the index; drops duplicates and unknown URLs for free.
    wanted = pd.Index(dict.fromkeys(req.profile_urls))
    req_df = df.loc[df.index.intersection(wanted)]

    results = {}

    if len(req_df) > 0:
        probs = model.predict_proba(req_df[feature_cols].fillna(0))[:, 1]
        probs = np.nan_to_num(np.asarray(probs, dtype=float),
                              nan=0.05, posinf=0.05, neginf=0.05)
        preds = probs >= 0.43  # tuned threshold

        drift = pd.to_numeric(req_df['semantic_drift_score'], errors='coerce') \
                  .fillna(0.0).clip(upper=1.0).to_numpy(dtype=float)
        relevancy = np.nan_to_num((1.0 - drift) * 5.0, nan=0.5, posinf=0.5, neginf=0.5)

        results = {
            url: {
                'hazard': 100 if pred else 10,
                'relevancy': round(float(rel), 4),
                'move_prob': round(float(prob), 6),
                'tenure': 24,
            }
            for url, pred, prob, rel in zip(req_df['profile_url'], preds, probs, relevancy)
        }

    # Fallback for URLs with no features on record.
    default = {'hazard': 10, 'relevancy': 0.5, 'move_prob': 0.05, 'tenure': 24}
    for url in req.profile_urls:
        results.setdefault(url, dict(default))

    return {"scored_candidates": results}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
