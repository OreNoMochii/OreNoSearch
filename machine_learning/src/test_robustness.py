import numpy as np
import pandas as pd
import joblib
import os
import sys
from pipeline import lgb_cox_objective

model_path = "/Users/zarb/exentive_projects/metaview_scraper/machine_learning/artifacts/lightgbm_survival_model.joblib"
times_path = "/Users/zarb/exentive_projects/metaview_scraper/machine_learning/artifacts/lgb_breslow_times.npy"
surv_path = "/Users/zarb/exentive_projects/metaview_scraper/machine_learning/artifacts/lgb_breslow_survival.npy"

# Add it to the main module so unpickler finds it
import __main__
__main__.lgb_cox_objective = lgb_cox_objective

lgb_model = joblib.load(model_path)
lgb_times = np.load(times_path)
lgb_survival = np.load(surv_path)

def calculate_conditional_probability_custom(times, survival, log_hazard, current_tenure_months, window=12):
    t1 = current_tenure_months
    t2 = current_tenure_months + window
    
    t1_idx = np.searchsorted(times, t1)
    if t1_idx >= len(times):
        t1_idx = len(times) - 1
    s0_t1 = survival[t1_idx]
    
    t2_idx = np.searchsorted(times, t2)
    if t2_idx >= len(times):
        t2_idx = len(times) - 1
    s0_t2 = survival[t2_idx]
    
    if s0_t1 <= 1e-5:
        return 0.95
    
    log_hazard_clipped = np.clip(log_hazard, -3.0, 3.0)
    prob = 1.0 - (s0_t2 / s0_t1) ** np.exp(log_hazard_clipped)
    return float(np.clip(prob, 0.01, 0.95))

# Create some test cases
test_cases = [
    # Extremely low tenure (1 month), no internal promotions, job hopper history
    {
        'total_years_experience': 2.0,
        'num_previous_companies': 4,
        'average_historical_tenure_months': 6.0,
        'median_tenure_months': 6.0,
        'is_tier_1': 0,
        'is_boomerang': 0,
        'had_internal_promotion': 0,
        'internal_move_rate': 0.0,
        'advanced_degree': 0,
        'log_summary_length': 0.0,
        'log_stay_desc_len': 2.0,
        'tenure_cv': 0.0,
        'is_founder_ceo': 0,
        '_current_tenure_months': 1
    },
    # Moderate tenure (24 months), stable history
    {
        'total_years_experience': 10.0,
        'num_previous_companies': 2,
        'average_historical_tenure_months': 60.0,
        'median_tenure_months': 60.0,
        'is_tier_1': 1,
        'is_boomerang': 0,
        'had_internal_promotion': 1,
        'internal_move_rate': 0.1,
        'advanced_degree': 1,
        'log_summary_length': 4.0,
        'log_stay_desc_len': 3.0,
        'tenure_cv': 0.0,
        'is_founder_ceo': 0,
        '_current_tenure_months': 24
    },
    # High tenure (84 months), very stable
    {
        'total_years_experience': 15.0,
        'num_previous_companies': 1,
        'average_historical_tenure_months': 96.0,
        'median_tenure_months': 96.0,
        'is_tier_1': 0,
        'is_boomerang': 1,
        'had_internal_promotion': 1,
        'internal_move_rate': 0.2,
        'advanced_degree': 0,
        'log_summary_length': 5.0,
        'log_stay_desc_len': 2.5,
        'tenure_cv': 0.0,
        'is_founder_ceo': 0,
        '_current_tenure_months': 84
    }
]

print("--- ROBUSTNESS TEST RESULTS ---")
for i, tc in enumerate(test_cases):
    features = {k: v for k, v in tc.items() if not k.startswith('_')}
    input_df = pd.DataFrame([features])
    
    log_hazard = lgb_model.predict(input_df)[0]
    prob = calculate_conditional_probability_custom(lgb_times, lgb_survival, log_hazard, tc['_current_tenure_months'])
    
    print(f"Test Case {i+1} (Tenure: {tc['_current_tenure_months']} mo):")
    print(f"  Raw log_hazard: {log_hazard:.4f} (clipped bounds [-3, 3])")
    print(f"  Exp hazard: {np.exp(np.clip(log_hazard, -3.0, 3.0)):.4f}")
    print(f"  Move Probability: {prob * 100:.1f}%\n")
