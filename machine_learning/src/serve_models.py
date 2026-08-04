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
    print("Model trained successfully!")
    return model, df, feature_cols

model_data = train_model()

class ScoreRequest(BaseModel):
    profile_urls: list[str]
    jd_text: str = ""

@app.post("/score")
def score_candidates(req: ScoreRequest):
    if not req.profile_urls or not model_data:
        return {"scored_candidates": {}}
        
    model, df, feature_cols = model_data
    
    # Filter the dataframe for the requested URLs
    mask = df['profile_url'].isin(req.profile_urls)
    req_df = df[mask].copy()
    
    results = {}
    
    if len(req_df) > 0:
        X_req = req_df[feature_cols].fillna(0)
        probs = model.predict_proba(X_req)[:, 1]
        preds = (probs >= 0.43).astype(int) # Using our tuned threshold
        
        for i, row in req_df.reset_index().iterrows():
            url = row['profile_url']
            prob = float(probs[i])
            pred = preds[i]
            drift = row['semantic_drift_score']
            if drift is None or (isinstance(drift, float) and np.isnan(drift)):
                drift = 0.0
            drift = float(drift)
            
            # Sanitize any remaining NaN/inf
            relevancy = (1.0 - min(drift, 1.0)) * 5.0
            if np.isnan(prob) or np.isinf(prob): prob = 0.05
            if np.isnan(relevancy) or np.isinf(relevancy): relevancy = 0.5
            
            results[url] = {
                'hazard': 100 if pred == 1 else 10,
                'relevancy': round(relevancy, 4),
                'move_prob': round(prob, 6),
                'tenure': 24
            }
    
    # Fallback for missing URLs
    for url in req.profile_urls:
        if url not in results:
            results[url] = {
                'hazard': 10,
                'relevancy': 0.5,
                'move_prob': 0.05,
                'tenure': 24
            }
            
    return {"scored_candidates": results}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
