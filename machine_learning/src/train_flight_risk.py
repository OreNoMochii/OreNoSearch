"""
QUARANTINED — this file trains on data it invents.

`generate_flight_risk_data` below is np.random.uniform. Every feature, the
risk score, the tenure and the event indicator are drawn from distributions
written by hand, then a Cox model is fitted to them and a "Model Performance"
table with a Concordance Index is printed. The c-index measures how well the
model recovered the arithmetic in `risk_score`; it says nothing about any
candidate. The event indicator is np.random.binomial(1, 0.4) — independent of
every feature — so even that number is mostly noise.

Nothing imports this module. It is kept because it is the file named after
the task, and someone will find it and run it. It must not be mistaken for a
trained model or a source of metrics.

The real work is the point-in-time panel built from observed transitions:
  - machine_learning/src/extract_career_dates.py  (recovers calendar dates)
  - machine_learning/src/build_snapshots.py       (observed moves)
  - docs/flight_risk.md                           (the plan)
"""

import pandas as pd
import numpy as np
from lifelines import CoxPHFitter
from lifelines.utils import concordance_index
from sklearn.model_selection import train_test_split


def generate_flight_risk_data(n_samples=5000):
    """
    Simulate the output of the JSON chronological parser for Flight Risk.
    In production, this is queried from the censored point-in-time database.
    """
    np.random.seed(42)
    
    # Features
    career_velocity = np.random.uniform(0.1, 1.5, n_samples)  # Promotions per year
    stagnation = np.random.uniform(0.1, 3.0, n_samples)       # Time since last title / Historical Avg
    stability = np.random.uniform(12, 60, n_samples)          # Historical average tenure (months)
    
    # Baseline hazard influenced by features
    # Higher stagnation -> higher hazard -> shorter tenure
    # Higher velocity -> generally ambitious, maybe shorter tenure
    risk_score = (stagnation * 1.5) + (career_velocity * 0.5) - (stability * 0.02)
    
    # Simulate current tenure based on exponential distribution parameterized by risk_score
    lambda_ = np.exp(risk_score) 
    current_tenure = np.random.exponential(scale=120/lambda_)
    
    # Simulate censoring: if they haven't moved yet (event = 0), or if they moved (event = 1)
    event_observed = np.random.binomial(1, p=0.4, size=n_samples) 
    
    df = pd.DataFrame({
        'career_velocity': career_velocity,
        'stagnation': stagnation,
        'stability': stability,
        'current_tenure_months': current_tenure,
        'event_observed': event_observed
    })
    return df

def train_survival_model():
    print("Generating/Loading Point-In-Time Censored Data...")
    df = generate_flight_risk_data()
    
    train_df, test_df = train_test_split(df, test_size=0.2, random_state=42)
    
    print("Training Cox Proportional Hazards Model (Survival Analysis)...")
    cph = CoxPHFitter(penalizer=0.01)
    cph.fit(train_df, duration_col='current_tenure_months', event_col='event_observed')
    
    # Predict partial hazards for the test set
    test_preds = cph.predict_partial_hazard(test_df)
    
    # Calculate Concordance Index (Accuracy equivalent for Survival Models)
    c_index = concordance_index(
        test_df['current_tenure_months'], 
        -test_preds, 
        test_df['event_observed']
    )
    
    print("\n=== Model Performance ===")
    print(f"Concordance Index (Accuracy): {c_index:.4f}")
    print("\n=== Feature Importance (Hazard Ratios) ===")
    print(cph.summary[['exp(coef)', 'p']])
    
    return cph

if __name__ == "__main__":
    train_survival_model()
