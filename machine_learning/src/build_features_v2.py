import os
import json
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env'))

MOVER_THRESHOLD_MONTHS = 10.0

def compute_career_velocity(roles_history):
    if not roles_history: return 0.0
    promotions = 0
    total_months = 0.0
    
    prev_tier = roles_history[0].get('seniority_tier', 1)
    for role in roles_history:
        tier = role.get('seniority_tier', 1)
        if tier > prev_tier: promotions += 1
        prev_tier = tier
        total_months += role.get('duration_months', 0)
        
    years = total_months / 12.0
    return promotions / years if years > 0 else 0.0

def compute_features_for_profile(profile_url, exp_json_data):
    try:
        exp_data = exp_json_data if isinstance(exp_json_data, list) else json.loads(exp_json_data)
    except:
        return None
        
    flat_roles = []
    stay_idx = 0
    
    for stay in exp_data:
        company = stay.get('company', '')
        normalized = stay.get('company_normalized', '')
        dur = stay.get('total_tenure_months', 0)
        is_cur = stay.get('is_current_company', False)
        roles = stay.get('roles', [])
        
        # Determine internal promotion info
        tiers = [r.get('seniority_tier', 1) for r in roles]
        max_t = max(tiers) if tiers else 1
        min_t = min(tiers) if tiers else 1
        delta = max_t - min_t
        latest_role = roles[0].get('title', '') if roles else ''
        is_founder = any(r.get('is_founder_ceo', False) for r in roles)
        
        flat_roles.append({
            'company': company,
            'company_normalized': normalized,
            'duration_months': dur,
            'is_current': is_cur,
            'stay_order': stay_idx,
            'num_internal_roles': len(roles),
            'max_seniority_tier': max_t,
            'min_seniority_tier': min_t,
            'seniority_delta': delta,
            'latest_role_title': latest_role,
            'is_founder_ceo': is_founder,
            'roles_detail': roles
        })
        stay_idx += 1
        
    if not flat_roles:
        return None
        
    # Sort roles to be sure order is correct: stay_order 0 is most recent
    # (The JSON array from the parser is already in scraped order, meaning 0 is most recent)
    
    current_stay = flat_roles[0]
    is_mover = 1 if (current_stay['is_current'] and current_stay['duration_months'] < MOVER_THRESHOLD_MONTHS) else 0
    
    # Point-in-time censoring
    if is_mover and len(flat_roles) > 1:
        # Censor: Treat the PREVIOUS role (index 1) as "current"
        observed_current = flat_roles[1]
        prior_history = flat_roles[2:]
        left_job_event = 1 # We know they left it!
    else:
        observed_current = current_stay
        prior_history = flat_roles[1:]
        left_job_event = 0 # Right-censored (they are still there as of observation)

    # Compute PRIOR history features
    prior_durations = [r['duration_months'] for r in prior_history if r['duration_months'] > 0]
    
    prior_total_exp = sum(prior_durations)
    prior_num_comp = len(prior_durations)
    prior_avg = float(np.mean(prior_durations)) if prior_durations else 0.0
    prior_med = float(np.median(prior_durations)) if prior_durations else 0.0
    prior_max = float(np.max(prior_durations)) if prior_durations else 0.0
    prior_min = float(np.min(prior_durations)) if prior_durations else 0.0
    prior_std = float(np.std(prior_durations)) if prior_durations else 0.0
    
    cv = (prior_std / prior_avg) if prior_avg > 0 else 0.0
    stability = max(0.0, 1.0 - min(1.0, cv))
    
    velocity = compute_career_velocity([r for stay in prior_history for r in reversed(stay['roles_detail'])])
    
    ratio = (observed_current['duration_months'] / prior_avg) if prior_avg > 0 else 0.0
    
    # Stagnation: how long have they been at their CURRENT seniority tier?
    # Count back from observed_current until tier changes
    current_tier = observed_current['max_seniority_tier']
    stagnation = float(observed_current['duration_months'])
    for stay in prior_history:
        if stay['max_seniority_tier'] >= current_tier:
            stagnation += float(stay['duration_months'])
        else:
            break

    # We also need to build candidate_career_events (all stays for survival analysis)
    cce_rows = []
    for stay in flat_roles:
        # For training a survival model on ALL historical stays, we compute features relative to THAT stay.
        # This is essentially recreating the point-in-time logic for EVERY role.
        s_idx = stay['stay_order']
        s_prior = flat_roles[s_idx+1:]
        
        s_prior_durs = [r['duration_months'] for r in s_prior if r['duration_months'] > 0]
        s_prior_total = sum(s_prior_durs)
        s_prior_num = len(s_prior_durs)
        s_prior_avg = float(np.mean(s_prior_durs)) if s_prior_durs else 0.0
        s_prior_med = float(np.median(s_prior_durs)) if s_prior_durs else 0.0
        s_prior_max = float(np.max(s_prior_durs)) if s_prior_durs else 0.0
        s_prior_min = float(np.min(s_prior_durs)) if s_prior_durs else 0.0
        s_prior_std = float(np.std(s_prior_durs)) if s_prior_durs else 0.0
        
        s_velocity = compute_career_velocity([r for ps in s_prior for r in reversed(ps['roles_detail'])])
        s_ratio = float(stay['duration_months'] / s_prior_avg) if s_prior_avg > 0 else 0.0
        
        s_current_tier = stay['max_seniority_tier']
        s_stagnation = float(stay['duration_months'])
        for ps in s_prior:
            if ps['max_seniority_tier'] >= s_current_tier:
                s_stagnation += float(ps['duration_months'])
            else:
                break
                
        # Is tier1? (Approximate for now, we'll join later)
        # Left job? 1 if it's not the most recent role, else 0
        s_left = 1 if s_idx > 0 else 0
        
        cce_rows.append({
            'profile_url': profile_url,
            'company': stay['company'],
            'company_normalized': stay['company_normalized'],
            'stay_order': stay['stay_order'],
            'duration_months': stay['duration_months'],
            'is_current': stay['is_current'],
            'left_job': s_left,
            'num_internal_roles': stay['num_internal_roles'],
            'max_seniority_tier': stay['max_seniority_tier'],
            'min_seniority_tier': stay['min_seniority_tier'],
            'seniority_delta': stay['seniority_delta'],
            'latest_role_title': stay['latest_role_title'],
            'is_founder_ceo': stay['is_founder_ceo'],
            'prior_total_exp_months': s_prior_total,
            'prior_num_companies': s_prior_num,
            'prior_avg_tenure_months': s_prior_avg,
            'prior_median_tenure_months': s_prior_med,
            'prior_max_tenure_months': s_prior_max,
            'prior_min_tenure_months': s_prior_min,
            'prior_tenure_std_months': s_prior_std,
            'career_velocity': s_velocity,
            'tenure_ratio': s_ratio,
            'seniority_stagnation_months': s_stagnation,
            # We don't have is_tier1_company or is_boomerang here easily, we can add them later via join
            'is_tier1_company': False,
            'is_boomerang': False,
            'role_text': " ".join([r.get('title', '') + " " + r.get('description', '') for r in stay['roles_detail']])
        })
        
    cf_row = {
        'profile_url': profile_url,
        'is_mover': is_mover,
        'current_tenure_months': observed_current['duration_months'],
        'current_company': observed_current['company'],
        'current_seniority_tier': observed_current['max_seniority_tier'],
        'is_founder_ceo': observed_current['is_founder_ceo'],
        'total_exp_months': prior_total_exp + observed_current['duration_months'],
        'num_companies': prior_num_comp + 1,
        'avg_tenure_months': prior_avg,
        'median_tenure_months': prior_med,
        'tenure_std_months': prior_std,
        'max_tenure_months': prior_max,
        'min_tenure_months': prior_min,
        'career_velocity': velocity,
        'tenure_stability_score': stability,
        'seniority_stagnation_months': stagnation,
        'flight_risk_ratio': ratio,
        'num_concurrent_roles': 0 # We'd need to calculate this from date overlap, but for now 0
    }
    
    return cf_row, cce_rows

def main():
    conn = psycopg2.connect(
        dbname=os.getenv('DB_NAME','metaview_scraper'),
        user=os.getenv('DB_USER','scraper_user'),
        password=os.getenv('DB_PASSWORD','scraper_password'),
        host=os.getenv('DB_HOST','localhost'),
        port=os.getenv('DB_PORT','5433')
    )
    conn.autocommit = True
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    
    print("Fetching parsed profiles...")
    cursor.execute("""
        SELECT p.profile_url, p.name, p.scraped_at, p.experience_json, p.education_json 
        FROM candidate_profiles_parsed p
        LEFT JOIN candidate_features_v2 f ON p.profile_url = f.profile_url
        WHERE f.profile_url IS NULL
    """)
    rows = cursor.fetchall()
    
    insert_cf_sql = """
        INSERT INTO candidate_features_v2 
        (profile_url, name, scraped_at, is_mover, current_tenure_months, current_company, 
         current_seniority_tier, is_founder_ceo, total_exp_months, num_companies, 
         avg_tenure_months, median_tenure_months, tenure_std_months, max_tenure_months, 
         min_tenure_months, career_velocity, tenure_stability_score, seniority_stagnation_months, 
         flight_risk_ratio, num_concurrent_roles)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (profile_url) DO UPDATE SET
            is_mover = EXCLUDED.is_mover,
            current_tenure_months = EXCLUDED.current_tenure_months,
            current_company = EXCLUDED.current_company,
            current_seniority_tier = EXCLUDED.current_seniority_tier,
            is_founder_ceo = EXCLUDED.is_founder_ceo,
            total_exp_months = EXCLUDED.total_exp_months,
            num_companies = EXCLUDED.num_companies,
            avg_tenure_months = EXCLUDED.avg_tenure_months,
            median_tenure_months = EXCLUDED.median_tenure_months,
            tenure_std_months = EXCLUDED.tenure_std_months,
            max_tenure_months = EXCLUDED.max_tenure_months,
            min_tenure_months = EXCLUDED.min_tenure_months,
            career_velocity = EXCLUDED.career_velocity,
            tenure_stability_score = EXCLUDED.tenure_stability_score,
            seniority_stagnation_months = EXCLUDED.seniority_stagnation_months,
            flight_risk_ratio = EXCLUDED.flight_risk_ratio,
            num_concurrent_roles = EXCLUDED.num_concurrent_roles
    """
    
    insert_cce_sql = """
        INSERT INTO candidate_career_events 
        (profile_url, company, company_normalized, stay_order, duration_months, is_current, left_job,
         num_internal_roles, max_seniority_tier, min_seniority_tier, seniority_delta, latest_role_title,
         is_founder_ceo, prior_total_exp_months, prior_num_companies, prior_avg_tenure_months,
         prior_median_tenure_months, prior_max_tenure_months, prior_min_tenure_months,
         prior_tenure_std_months, career_velocity, tenure_ratio, seniority_stagnation_months)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    
    # We no longer truncate because we are running incrementally
    
    cf_batch = []
    cce_batch = []
    batch_size = 500
    insert_cursor = conn.cursor()
    
    print("Computing features...")
    for row in tqdm(rows):
        res = compute_features_for_profile(row['profile_url'], row['experience_json'])
        if not res: continue
        cf_row, cce_rows = res
        
        cf_batch.append((
            cf_row['profile_url'], row['name'], row['scraped_at'], cf_row['is_mover'],
            cf_row['current_tenure_months'], cf_row['current_company'], cf_row['current_seniority_tier'],
            cf_row['is_founder_ceo'], cf_row['total_exp_months'], cf_row['num_companies'],
            cf_row['avg_tenure_months'], cf_row['median_tenure_months'], cf_row['tenure_std_months'],
            cf_row['max_tenure_months'], cf_row['min_tenure_months'], cf_row['career_velocity'],
            cf_row['tenure_stability_score'], cf_row['seniority_stagnation_months'],
            cf_row['flight_risk_ratio'], cf_row['num_concurrent_roles']
        ))
        
        for c in cce_rows:
            cce_batch.append((
                c['profile_url'], c['company'], c['company_normalized'], c['stay_order'],
                c['duration_months'], c['is_current'], c['left_job'], c['num_internal_roles'],
                c['max_seniority_tier'], c['min_seniority_tier'], c['seniority_delta'],
                c['latest_role_title'], c['is_founder_ceo'], c['prior_total_exp_months'],
                c['prior_num_companies'], c['prior_avg_tenure_months'], c['prior_median_tenure_months'],
                c['prior_max_tenure_months'], c['prior_min_tenure_months'], c['prior_tenure_std_months'],
                c['career_velocity'], c['tenure_ratio'], c['seniority_stagnation_months']
            ))
            
        if len(cf_batch) >= batch_size:
            insert_cursor.executemany(insert_cf_sql, cf_batch)
            cf_batch = []
        if len(cce_batch) >= batch_size * 5:
            insert_cursor.executemany(insert_cce_sql, cce_batch)
            cce_batch = []
            
    if cf_batch:
        insert_cursor.executemany(insert_cf_sql, cf_batch)
    if cce_batch:
        insert_cursor.executemany(insert_cce_sql, cce_batch)
        
    print("Done!")
    insert_cursor.close()
    cursor.close()
    conn.close()

if __name__ == "__main__":
    main()
