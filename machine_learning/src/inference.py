import sys
import json
import joblib
import os
import psycopg2
import pandas as pd
import numpy as np
import re
import torch
from dotenv import load_dotenv

# Load environment variables from the project root
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
load_dotenv(dotenv_path=env_path)

# We import the parsing function and model from the pipeline script
from pipeline import (parse_experience, extract_historical_stays, AttritionLSTM, lgb_cox_objective,
                      DB_EN_TO_CANONICAL, DB_JA_TO_CANONICAL, _strip_legal_suffixes,
                      has_advanced_degree, summary_length, extract_latest_job_description_length,
                      is_founder_ceo)

def calculate_conditional_probability(cph, X_row, current_tenure_months, window=12):
    # Predict the baseline hazard multiplier
    partial_hazard = cph.predict_partial_hazard(X_row)[0]
    
    # baseline survival dataframe
    base_surv = cph.baseline_survival_
    times = base_surv.index.values
    
    t1 = current_tenure_months
    t2 = current_tenure_months + window
    
    # Find t1 and t2 in baseline index
    t1_idx = np.searchsorted(times, t1)
    if t1_idx >= len(times):
        t1_idx = len(times) - 1
    s0_t1 = base_surv.iloc[t1_idx, 0]
    
    t2_idx = np.searchsorted(times, t2)
    if t2_idx >= len(times):
        t2_idx = len(times) - 1
    s0_t2 = base_surv.iloc[t2_idx, 0]
    
    if s0_t1 <= 1e-5:
        return 0.95  # Cap at 95%
    
    # Clip partial hazard to prevent extreme predictions
    partial_hazard_clipped = np.clip(partial_hazard, 0.05, 20.0)
        
    prob = 1.0 - (s0_t2 / s0_t1) ** partial_hazard_clipped
    return float(np.clip(prob, 0.01, 0.95))

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
        return 0.95  # Cap at 95% instead of 100% — we can never be certain
    
    # Fix #3: Clip log_hazard to prevent extreme predictions
    # exp(-3) ≈ 0.05, exp(3) ≈ 20 — keeps probabilities in usable range
    log_hazard_clipped = np.clip(log_hazard, -3.0, 3.0)
        
    prob = 1.0 - (s0_t2 / s0_t1) ** np.exp(log_hazard_clipped)
    return float(np.clip(prob, 0.01, 0.95))

def main():
    # Read URLs from stdin
    input_data = sys.stdin.read()
    if not input_data:
        print(json.dumps({}))
        return
        
    try:
        urls = json.loads(input_data)
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
        return
 
    if not urls:
        print(json.dumps({}))
        return
 
    # Load Models
    try:
        model_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'artifacts')
        meta_path = os.path.join(model_dir, 'best_model_meta.json')
        if os.path.exists(meta_path):
            with open(meta_path, 'r') as f:
                meta = json.load(f)
            best_model_type = meta.get('best_model_type', 'coxph')
        else:
            best_model_type = 'coxph'
            
        cph = None
        lgb_model = None
        lstm_model = None
        
        if best_model_type == 'coxph':
            cox_path = os.path.join(model_dir, 'cox_survival_model.joblib')
            cph = joblib.load(cox_path)
        elif best_model_type == 'lightgbm':
            lgb_path = os.path.join(model_dir, 'lightgbm_survival_model.joblib')
            lgb_model = joblib.load(lgb_path)
            lgb_times = np.load(os.path.join(model_dir, 'lgb_breslow_times.npy'))
            lgb_survival = np.load(os.path.join(model_dir, 'lgb_breslow_survival.npy'))
        elif best_model_type == 'lstm':
            lstm_path = os.path.join(model_dir, 'lstm_survival_model.pt')
            lstm_model = AttritionLSTM(input_dim=20, hidden_dim=32, num_layers=1)
            lstm_model.load_state_dict(torch.load(lstm_path, map_location='cpu'))
            lstm_model.eval()
            lstm_times = np.load(os.path.join(model_dir, 'lstm_breslow_times.npy'))
            lstm_survival = np.load(os.path.join(model_dir, 'lstm_breslow_survival.npy'))
            
    except Exception as e:
        print(json.dumps({"error": f"Failed to load model: {str(e)}"}))
        return
 
    # Connect to DB
    try:
        conn = psycopg2.connect(
            host=os.getenv("DB_HOST", "localhost"),
            database=os.getenv("DB_NAME", "metaview_scraper"),
            user=os.getenv("DB_USER", "scraper_user"),
            password=os.getenv("DB_PASSWORD", "scraper_password"),
            port=os.getenv("DB_PORT", "5433")
        )
    except Exception as e:
        print(json.dumps({"error": f"DB Connection failed: {str(e)}"}))
        return
 
    query = """
        SELECT profile_url, experience, email, education, summary FROM candidates_data_science_use WHERE profile_url = ANY(%s)
        UNION
        SELECT profile_url, experience, email, education, summary FROM candidates_upgraded WHERE profile_url = ANY(%s)
    """
    df = pd.read_sql(query, conn, params=(urls, urls))
    
    # Load bidirectional company maps for JP/EN normalization
    import unicodedata
    def _has_cjk(text):
        return any(unicodedata.category(c).startswith('Lo') for c in text if c.strip())
    
    cursor = conn.cursor()
    cursor.execute("SELECT name, name_ja FROM companies_analyzed WHERE name_ja IS NOT NULL AND name_ja != 'SKIP'")
    for row_ca in cursor.fetchall():
        en_name, ja_name = row_ca
        if en_name and ja_name:
            canonical = en_name.lower().strip()
            if _has_cjk(en_name):
                DB_JA_TO_CANONICAL[en_name.lower().strip()] = canonical
                ja_s = _strip_legal_suffixes(en_name).lower().strip()
                if ja_s:
                    DB_JA_TO_CANONICAL[ja_s] = canonical
            else:
                DB_EN_TO_CANONICAL[canonical] = canonical
                en_stripped = _strip_legal_suffixes(en_name).lower().strip()
                if en_stripped:
                    DB_EN_TO_CANONICAL[en_stripped] = canonical
            ja_lower = ja_name.lower().strip()
            DB_JA_TO_CANONICAL[ja_lower] = canonical
            ja_stripped = _strip_legal_suffixes(ja_name).lower().strip()
            if ja_stripped:
                DB_JA_TO_CANONICAL[ja_stripped] = canonical
    cursor.close()
    conn.close()
 
    if df.empty:
        print(json.dumps({}))
        return
 
    results = {}
    
    public_domains = ['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'proton', 'me.com', 'live.com', 'msn.com', 'aol.com']
 
    for _, row in df.iterrows():
        url = row['profile_url']
        feats = parse_experience(row['experience'])
        
        # Email Features
        email = row.get('email', '')
        has_email = 1 if email and str(email).strip() else 0
        is_corp = 0
        if has_email:
            domain = str(email).split('@')[-1].lower()
            if not any(pub in domain for pub in public_domains):
                is_corp = 1
 
        # Calculate new features
        adv_deg = has_advanced_degree(row.get('education', ''))
        sum_len = summary_length(row.get('summary', ''))
        exp_len = extract_latest_job_description_length(row.get('experience', ''))
        log_sum_len = float(np.log1p(sum_len))
        log_exp_len = float(np.log1p(exp_len))

        # Calculate features at start of current stay
        stays = extract_historical_stays(row['experience'])
        if stays:
            current_stay = stays[0]
            total_exp = current_stay['total_years_experience']
            num_prev = current_stay['num_previous_companies']
            avg_hist = current_stay['average_historical_tenure_months']
            med_tenure = current_stay['median_tenure_months']
            is_tier_1 = current_stay['is_tier_1']
            is_boomerang = current_stay['is_boomerang']
            had_internal_promotion = current_stay['had_internal_promotion']
            internal_move_rate = current_stay['internal_move_rate']
            company_tenure = current_stay['duration_months']
            is_founder_ceo_val = current_stay.get('is_founder_ceo', 0)
        else:
            total_exp = feats['total_years_experience']
            num_prev = feats['num_previous_companies']
            avg_hist = 0.1
            med_tenure = 0.0
            is_tier_1 = 0
            is_boomerang = 0
            had_internal_promotion = 0
            internal_move_rate = 0.0
            company_tenure = feats['current_tenure_months']
            is_founder_ceo_val = 0
            
        # Tenure CV
        tenure_cv = abs(avg_hist - med_tenure) / avg_hist if avg_hist > 0 else 0.0
 
        # Dataframe for prediction
        input_df_surv = pd.DataFrame([{
            'total_years_experience': total_exp,
            'average_historical_tenure_months': avg_hist,
            'median_tenure_months': med_tenure,
            'is_tier_1': is_tier_1,
            'is_boomerang': is_boomerang,
            'had_internal_promotion': had_internal_promotion,
            'internal_move_rate': internal_move_rate,
            'advanced_degree': adv_deg,
            'log_summary_length': log_sum_len,
            'log_stay_desc_len': np.log1p(len(feats.get('current_company', '').split())),
            'is_founder_ceo': is_founder_ceo_val,
            'company_flight_risk': 0.0,
            'seniority_stagnation_months': 0.0,
            'career_velocity': 0.0,
            'record_tenure_ratio': 1.0,
            'historical_loyalty_index': 1.0,
            'tenure_ratio': 0.0,
            'seniority_delta': 0.0,
            'prior_tenure_std': 0.0,
            'prior_max_tenure': 0.0,
            'max_seniority_tier': 1.0,
            'num_internal_roles': 1.0,
            'tenure_range_ratio': 1.0,
            'seniority_velocity': 0.0,
            'num_skills': 0,
            'skill_breadth': 0
        }])
        
        try:
            if best_model_type == 'coxph':
                hazard = cph.predict_partial_hazard(input_df_surv)[0]
                move_prob = calculate_conditional_probability(cph, input_df_surv, company_tenure)
            elif best_model_type == 'lightgbm':
                log_hazard = lgb_model.predict(input_df_surv)[0]
                hazard = np.exp(log_hazard)
                move_prob = calculate_conditional_probability_custom(
                    lgb_times, lgb_survival, log_hazard, company_tenure
                )
            elif best_model_type == 'lstm':
                if stays:
                    stays_chronological = stays[::-1]
                    seq_len = len(stays_chronological)
                    
                    # Original core features
                    prior_exp_vals = [s['total_years_experience'] for s in stays_chronological]
                    avg_hist_tenure = [s['average_historical_tenure_months'] for s in stays_chronological]
                    median_tenure = [s['median_tenure_months'] for s in stays_chronological]
                    
                    # The 6 fixed features
                    is_tier_1 = [s['is_tier_1'] for s in stays_chronological]
                    is_boomerang = [s['is_boomerang'] for s in stays_chronological]
                    advanced_degree = [adv_deg] * seq_len
                    is_founder_ceo = [s.get('is_founder_ceo', 0) for s in stays_chronological]
                    company_flight_risk = [0.0] * seq_len
                    career_velocity = [0.0] * seq_len
                    
                    # Computed features
                    had_internal_promotion = [s['had_internal_promotion'] for s in stays_chronological]
                    internal_move_rate = [s['internal_move_rate'] for s in stays_chronological]
                    log_summary_length = [log_sum_len] * seq_len
                    log_stay_desc_len = [np.log1p(len(s.get('company', '').split())) for s in stays_chronological]
                    seniority_stagnation = [0.0] * seq_len
                    record_tenure_ratio = [s.get('record_tenure_ratio', 1.0) for s in stays_chronological]
                    hist_loyalty_index = [s.get('historical_loyalty_index', 1.0) for s in stays_chronological]
                    
                    # 10 New high-signal DB features
                    tenure_ratio = [0.0] * seq_len
                    seniority_delta = [0.0] * seq_len
                    prior_tenure_std = [0.0] * seq_len
                    prior_max_tenure = [0.0] * seq_len
                    max_seniority_tier = [1.0] * seq_len
                    num_internal_roles = [1.0] * seq_len
                    tenure_range_ratio = [1.0] * seq_len
                    seniority_velocity = [0.0] * seq_len
                    num_skills = [0] * seq_len
                    skill_breadth = [0] * seq_len
                    X_seq = np.column_stack([
                        prior_exp_vals,
                        avg_hist_tenure,
                        median_tenure,
                        is_tier_1,
                        is_boomerang,
                        had_internal_promotion,
                        internal_move_rate,
                        advanced_degree,
                        log_summary_length,
                        log_stay_desc_len,
                        is_founder_ceo,
                        company_flight_risk,
                        seniority_stagnation,
                        career_velocity,
                        record_tenure_ratio,
                        hist_loyalty_index,
                        tenure_ratio,
                        seniority_delta,
                        prior_tenure_std,
                        prior_max_tenure,
                        max_seniority_tier,
                        num_internal_roles,
                        tenure_range_ratio,
                        seniority_velocity,
                        num_skills,
                        skill_breadth
                    ]).astype(np.float32)
                else:
                    X_seq = np.zeros((1, 26), dtype=np.float32)
                    
                X_seq_tensor = torch.tensor([X_seq], dtype=torch.float32)
                lengths_tensor = torch.tensor([X_seq.shape[0]], dtype=torch.long)
                
                with torch.no_grad():
                    log_hazards = lstm_model(X_seq_tensor, lengths_tensor)
                    log_hazard = log_hazards[0, -1].item()
                    
                hazard = np.exp(log_hazard)
                move_prob = calculate_conditional_probability_custom(
                    lstm_times, lstm_survival, log_hazard, company_tenure
                )
                
            results[url] = {
                "hazard": float(hazard),
                "move_prob": float(move_prob),
                "tenure": float(company_tenure),
                "median_tenure": float(med_tenure),
                "email": str(email) if email else ""
            }
        except Exception as e:
            results[url] = {"hazard": 1.0, "move_prob": 0.5, "tenure": 0, "email": ""}
 
    print(json.dumps(results))
 
if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    main()
