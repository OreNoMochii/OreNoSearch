import psycopg2
import psycopg2.extras
import os
import pandas as pd
import json
import numpy as np
import time

def extract_all():
    conn_read = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        port=os.getenv("DB_PORT", "5433")
    )
    
    conn_write = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        port=os.getenv("DB_PORT", "5433")
    )
    
    cur_write = conn_write.cursor()
    
    # 1. Create the features table
    print("Initializing ml_training_features table...")
    cur_write.execute("""
    CREATE TABLE IF NOT EXISTS ml_training_features (
        cce_id INTEGER PRIMARY KEY,
        profile_url TEXT,
        company_normalized TEXT,
        date_start DATE,
        duration_months REAL,
        left_job INTEGER,
        total_years_experience REAL,
        average_historical_tenure_months REAL,
        median_tenure_months REAL,
        is_tier_1 INTEGER,
        is_boomerang INTEGER,
        had_internal_promotion INTEGER,
        internal_move_rate REAL,
        advanced_degree INTEGER,
        log_summary_length REAL,
        log_stay_desc_len REAL,
        is_founder_ceo INTEGER,
        company_flight_risk REAL,
        seniority_stagnation_months REAL,
        career_velocity REAL,
        record_tenure_ratio REAL,
        historical_loyalty_index REAL,
        tenure_ratio REAL,
        seniority_delta REAL,
        prior_tenure_std REAL,
        prior_max_tenure REAL,
        max_seniority_tier REAL,
        num_internal_roles REAL,
        tenure_range_ratio REAL,
        seniority_velocity REAL,
        num_skills INTEGER,
        skill_breadth INTEGER
    )
    """)
    conn_write.commit()
    
    # 2. Get global company churn mapping
    print("Computing global company flight risk map...")
    cur_write.execute("SELECT company_normalized, AVG(left_job) FROM candidate_career_events GROUP BY company_normalized")
    company_churn_map = {row[0]: row[1] for row in cur_write.fetchall()}
    global_churn_mean = np.mean(list(company_churn_map.values()))
    
    # 3. Find missing IDs incrementally
    query = """
    SELECT 
        cce.id,
        cce.profile_url,
        cce.company_normalized,
        cce.company,
        cce.start_approx as date_start,
        cce.duration_months,
        cce.left_job,
        cce.prior_total_exp_months,
        cce.prior_avg_tenure_months,
        cce.prior_median_tenure_months,
        cce.num_internal_roles,
        cce.is_founder_ceo,
        cce.seniority_stagnation_months,
        cce.max_seniority_tier,
        cce.tenure_ratio,
        cce.seniority_delta,
        cce.prior_tenure_std_months,
        cce.prior_max_tenure_months,
        cce.is_boomerang,
        v1.summary,
        v2.education_json,
        v2.experience_json,
        COALESCE(jsonb_array_length(ces.technical_skills), 0) as num_tech_skills,
        (
            (CASE WHEN jsonb_array_length(ces.technical_skills) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.domain_expertise) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.tools_platforms) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.soft_skills) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.languages) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.certifications) > 0 THEN 1 ELSE 0 END)
        ) as skill_breadth
    FROM candidate_career_events cce
    LEFT JOIN candidates_data_science_use v1 ON cce.profile_url = v1.profile_url
    JOIN candidates_data_science_use_v2 v2 ON cce.profile_url = v2.profile_url
    LEFT JOIN candidate_extracted_skills ces ON cce.profile_url = ces.profile_url
    WHERE cce.duration_months > 0 
      AND cce.id NOT IN (SELECT cce_id FROM ml_training_features)
    """
    
    print("Executing server-side cursor for true streaming...")
    server_cur = conn_read.cursor('stream_cursor')
    server_cur.itersize = 25000
    server_cur.execute(query)
    
    tier1_names = ['google','amazon','microsoft','apple','mckinsey','bcg','bain','goldman','netflix','meta','deloitte','accenture','jpmorgan']
    
    def has_advanced_degree(json_str):
        if not json_str: return 0
        s = str(json_str).lower()
        if 'master' in s or 'phd' in s or 'm.s' in s or 'mba' in s: return 1
        return 0

    def compute_stay_desc_len(row):
        exp = row.get('experience_json')
        if not exp: return 0
        if isinstance(exp, str):
            try: exp = json.loads(exp)
            except: return 0
        if not isinstance(exp, list): return 0
        desc_len = 0
        for e in exp:
            if isinstance(e, dict) and e.get('roles'):
                for r in e['roles']:
                    if r.get('company') == row.get('company') and r.get('description'):
                        desc_len += len(str(r['description']).split())
        return desc_len

    total_inserted = 0
    start_t = time.time()
    chunk_idx = 0
    
    while True:
        rows = server_cur.fetchmany(25000)
        if not rows:
            break
            
        if chunk_idx == 0:
            col_names = [desc[0] for desc in server_cur.description]
            
        chunk_idx += 1
        t_c = time.time()
        
        df = pd.DataFrame(rows, columns=col_names)
        
        df['total_years_experience'] = df['prior_total_exp_months'] / 12.0
        df['average_historical_tenure_months'] = df['prior_avg_tenure_months']
        df['median_tenure_months'] = df['prior_median_tenure_months']
        
        df['is_tier_1'] = df['company_normalized'].str.lower().apply(lambda x: 1 if any(t in str(x) for t in tier1_names) else 0)
        df['had_internal_promotion'] = (df['num_internal_roles'].fillna(1) > 1).astype(int)
        
        df['total_career_months'] = df['prior_total_exp_months'].fillna(0) + df['duration_months'].fillna(0)
        df['internal_move_rate'] = np.where(df['total_career_months'] > 0, df['num_internal_roles'].fillna(1) / (df['total_career_months'] / 12.0), 0.0)
        
        df['advanced_degree'] = df['education_json'].apply(lambda x: has_advanced_degree(x))
        df['log_summary_length'] = np.log1p(df['summary'].str.len().fillna(0))
        df['log_stay_desc_len'] = np.log1p(df.apply(compute_stay_desc_len, axis=1))
        
        df['is_boomerang'] = df['is_boomerang'].fillna(0).astype(int)
        df['is_founder_ceo'] = df['is_founder_ceo'].fillna(0).astype(int)
        df['company_flight_risk'] = df['company_normalized'].map(company_churn_map).fillna(global_churn_mean)
        
        df['career_velocity'] = df['max_seniority_tier'].fillna(1.0) / (df['prior_total_exp_months'].clip(1) / 12.0)
        df['record_tenure_ratio'] = df['tenure_ratio'].fillna(0.0)
        df['historical_loyalty_index'] = df['prior_max_tenure_months'].fillna(0.0) / df['average_historical_tenure_months'].clip(1)
        df['tenure_range_ratio'] = (df['prior_max_tenure_months'].fillna(0.0) - df['median_tenure_months'].fillna(0.0)) / df['median_tenure_months'].clip(1)
        df['seniority_velocity'] = df['seniority_delta'].fillna(0.0) / df['prior_total_exp_months'].clip(1)
        
        insert_cols = [
            'id', 'profile_url', 'company_normalized', 'date_start', 'duration_months', 'left_job',
            'total_years_experience', 'average_historical_tenure_months', 'median_tenure_months',
            'is_tier_1', 'is_boomerang', 'had_internal_promotion', 'internal_move_rate',
            'advanced_degree', 'log_summary_length', 'log_stay_desc_len', 'is_founder_ceo',
            'company_flight_risk', 'seniority_stagnation_months', 'career_velocity',
            'record_tenure_ratio', 'historical_loyalty_index', 'tenure_ratio', 'seniority_delta',
            'prior_tenure_std_months', 'prior_max_tenure_months', 'max_seniority_tier',
            'num_internal_roles', 'tenure_range_ratio', 'seniority_velocity', 'num_tech_skills', 'skill_breadth'
        ]
        
        for c in insert_cols:
            if c not in df.columns: continue
            if df[c].dtype in [np.float64, np.float32]:
                df[c] = df[c].fillna(0.0)
            elif df[c].dtype in [np.int64, np.int32, bool]:
                df[c] = df[c].fillna(0)
                
        records = df[insert_cols].values.tolist()
        
        insert_query = f"""
        INSERT INTO ml_training_features (
            cce_id, profile_url, company_normalized, date_start, duration_months, left_job,
            total_years_experience, average_historical_tenure_months, median_tenure_months,
            is_tier_1, is_boomerang, had_internal_promotion, internal_move_rate,
            advanced_degree, log_summary_length, log_stay_desc_len, is_founder_ceo,
            company_flight_risk, seniority_stagnation_months, career_velocity,
            record_tenure_ratio, historical_loyalty_index, tenure_ratio, seniority_delta,
            prior_tenure_std, prior_max_tenure, max_seniority_tier,
            num_internal_roles, tenure_range_ratio, seniority_velocity, num_skills, skill_breadth
        ) VALUES %s
        ON CONFLICT (cce_id) DO NOTHING
        """
        psycopg2.extras.execute_values(cur_write, insert_query, records)
        conn_write.commit()
        
        total_inserted += len(records)
        print(f"Chunk {chunk_idx} inserted ({len(records)} rows) in {time.time() - t_c:.2f}s. Total: {total_inserted}")
        
    print(f"Extraction complete! Total time: {time.time() - start_t:.2f}s")
    server_cur.close()
    conn_read.close()
    cur_write.close()
    conn_write.close()

if __name__ == '__main__':
    extract_all()
