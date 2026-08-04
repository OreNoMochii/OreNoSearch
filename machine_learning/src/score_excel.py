"""
Ad-hoc Excel scoring script.

Uses the SAME inference logic as the production inference.py:
- Fetches experience/education/summary from candidates_data_science_use
- Parses features via parse_experience + extract_historical_stays
- Scores via the best trained LightGBM survival model (C-Index 0.9688)
- Populates the existing 'Move Prob (%)', 'Hazard', 'Tenure (months)' columns
"""
import os
import sys
import json
import joblib
import psycopg2
import pandas as pd
import numpy as np
from dotenv import load_dotenv

# Load environment variables
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
load_dotenv(dotenv_path=env_path)

# Import pipeline helper functions (same as production inference.py)
from pipeline import (parse_experience, extract_historical_stays, lgb_cox_objective,
                       has_advanced_degree, summary_length, extract_latest_job_description_length,
                       is_founder_ceo, _strip_legal_suffixes, DB_EN_TO_CANONICAL, DB_JA_TO_CANONICAL)

# Bind lgb_cox_objective to __main__ so joblib can unpickle the LightGBM model
setattr(sys.modules['__main__'], 'lgb_cox_objective', lgb_cox_objective)

from inference import calculate_conditional_probability_custom


def main():
    # ── Locate the Excel file ──
    target_paths = [
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'ai_engineer_2026-07-27.xlsx'),
        os.path.join(os.path.dirname(os.path.dirname(__file__)), 'ai_engineer_2026-07-27.xlsx'),
        '/Users/zarb/Downloads/ai_engineer_2026-07-27.xlsx'
    ]

    excel_path = None
    for p in target_paths:
        if os.path.exists(p):
            try:
                with open(p, 'rb') as f:
                    f.read(10)
                excel_path = p
                break
            except Exception:
                continue

    if not excel_path:
        print("Error: Cannot find ai_engineer_2026-07-27.xlsx")
        print("  cp ~/Downloads/ai_engineer_2026-07-27.xlsx ~/exentive_projects/metaview_scraper/")
        sys.exit(1)

    print(f"Reading: {excel_path}")
    df = pd.read_excel(excel_path)
    print(f"Loaded {len(df)} candidates")

    # ── Load the best model (LightGBM survival, C-Index 0.9688) ──
    model_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'artifacts')
    meta_path = os.path.join(model_dir, 'best_model_meta.json')
    with open(meta_path, 'r') as f:
        meta = json.load(f)
    best_model_type = meta.get('best_model_type', 'lightgbm')
    c_index = meta.get('c_index', 0.9688)
    print(f"--> Model: {best_model_type.upper()} (C-Index: {c_index:.4f})")

    lgb_model = joblib.load(os.path.join(model_dir, 'lightgbm_survival_model.joblib'))
    lgb_times = np.load(os.path.join(model_dir, 'lgb_breslow_times.npy'))
    lgb_survival = np.load(os.path.join(model_dir, 'lgb_breslow_survival.npy'))

    # ── Connect to DB and fetch experience data ──
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        port=os.getenv("DB_PORT", "5433")
    )

    # Load company name maps (same as production inference.py)
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

    # Fetch experience/education/summary from the DB for all Excel URLs
    import urllib.parse
    urls = df['Profile URL'].dropna().astype(str).tolist()
    
    # Create variants of URLs (raw, unquoted, quoted) to handle mismatches with DB
    url_variants = set()
    for u in urls:
        url_variants.add(u)
        url_variants.add(urllib.parse.unquote(u))
        # Quote the path part (after https://www.linkedin.com/in/)
        if '/in/' in u:
            base, path = u.split('/in/', 1)
            url_variants.add(f"{base}/in/{urllib.parse.quote(urllib.parse.unquote(path))}")
    
    search_urls = list(url_variants)
    
    db_df1 = pd.read_sql(
        "SELECT profile_url, experience, education, summary FROM candidates_data_science_use WHERE profile_url = ANY(%s)",
        conn, params=(search_urls,)
    )
    db_df2 = pd.read_sql(
        "SELECT profile_url, experience, education, summary FROM candidates_upgraded WHERE profile_url = ANY(%s)",
        conn, params=(search_urls,)
    )
    
    db_df = pd.concat([db_df1, db_df2]).drop_duplicates(subset=['profile_url'], keep='last')
    
    db_map = {}
    for _, row in db_df.iterrows():
        # Store under both quoted and unquoted keys so we can find it
        raw_url = row['profile_url']
        unquoted = urllib.parse.unquote(raw_url)
        data = {
            'experience': row['experience'] or '',
            'education': row['education'] or '',
            'summary': row['summary'] or ''
        }
        db_map[raw_url] = data
        db_map[unquoted] = data

    print(f"DB experience data found for {len(db_df)} distinct DB records")

    # ── Score each candidate (production inference.py logic) ──
    move_probs = []
    hazards = []
    tenures = []
    scored = 0
    skipped = 0

    for idx, row in df.iterrows():
        url = str(row.get('Profile URL', ''))
        unquoted_url = urllib.parse.unquote(url)
        
        # Try finding the url in db_map (handles both quoted/unquoted keys)
        db_row = db_map.get(url) or db_map.get(unquoted_url)
        
        if not db_row or len(db_row['experience'].strip()) < 10:
            move_probs.append(np.nan)
            hazards.append(np.nan)
            tenures.append(np.nan)
            skipped += 1
            continue

        exp_text = db_row['experience']
        edu_text = db_row['education']
        summary_text = db_row['summary']

        feats = parse_experience(exp_text)
        stays = extract_historical_stays(exp_text)

        # Extract features — exact same logic as inference.py lines 196-221
        adv_deg = has_advanced_degree(edu_text)
        sum_len = summary_length(summary_text)
        exp_len = extract_latest_job_description_length(exp_text)
        log_sum_len = float(np.log1p(sum_len))

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

        tenure_cv = abs(avg_hist - med_tenure) / avg_hist if avg_hist > 0 else 0.0

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
            'log_stay_desc_len': float(np.log1p(len(feats.get('current_company', '').split()))),
            'is_founder_ceo': is_founder_ceo_val,
            'company_flight_risk': 0.0,
            'seniority_stagnation_months': 0.0,
            'career_velocity': 0.0,
            'record_tenure_ratio': current_stay.get('record_tenure_ratio', 1.0) if stays else 1.0,
            'historical_loyalty_index': current_stay.get('historical_loyalty_index', 1.0) if stays else 1.0,
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
            log_hazard = lgb_model.predict(input_df_surv)[0]
            hazard = float(np.exp(np.clip(log_hazard, -3.0, 3.0)))
            move_prob = float(calculate_conditional_probability_custom(
                lgb_times, lgb_survival, log_hazard, company_tenure
            ))
        except Exception as e:
            hazard = np.nan
            move_prob = np.nan
            company_tenure = np.nan

        move_probs.append(move_prob)
        hazards.append(hazard)
        tenures.append(company_tenure)
        scored += 1

    conn.close()

    # ── Populate the existing columns ──
    df['Move Prob (%)'] = [round(p * 100, 1) if pd.notnull(p) else np.nan for p in move_probs]
    df['Hazard'] = [round(h, 4) if pd.notnull(h) else np.nan for h in hazards]
    df['Tenure (months)'] = [round(t, 1) if pd.notnull(t) else np.nan for t in tenures]

    # ── Save ──
    out_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    out_xlsx = os.path.join(out_dir, "ai_engineer_2026-07-27_scored.xlsx")
    out_csv = os.path.join(out_dir, "ai_engineer_2026-07-27_scored.csv")

    df.to_excel(out_xlsx, index=False)
    df.to_csv(out_csv, index=False)

    downloads_xlsx = '/Users/zarb/Downloads/ai_engineer_2026-07-27_scored.xlsx'
    try:
        df.to_excel(downloads_xlsx, index=False)
        print(f"📁 Also saved to Downloads: {downloads_xlsx}")
    except Exception:
        pass

    print(f"\n✅ Scored {scored} candidates ({skipped} skipped — no experience data in DB)")
    print(f"📁 {out_xlsx}")
    print(f"📁 {out_csv}")

    # ── Print ranked summary ──
    df_scored = df.dropna(subset=['Move Prob (%)']).sort_values(by='Move Prob (%)', ascending=False)
    print(f"\n--- TOP 15 FLIGHT RISK CANDIDATES (of {len(df_scored)} scored) ---")
    for i, (_, r) in enumerate(df_scored.head(15).iterrows(), 1):
        prob = r['Move Prob (%)']
        haz = r['Hazard']
        ten = r['Tenure (months)']
        if prob >= 60:
            icon = "🔥"
        elif prob >= 35:
            icon = "⚡"
        else:
            icon = "🧊"
        print(f"  {i:2d}. {icon} {r['Name']:<25s} | {str(r['Company']):<25s} | Move: {prob:5.1f}% | Hazard: {haz:.3f} | Tenure: {ten:.0f}mo")


if __name__ == '__main__':
    import warnings
    warnings.filterwarnings("ignore")
    main()
