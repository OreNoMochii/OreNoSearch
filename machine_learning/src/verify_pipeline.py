import os
import json
import psycopg2
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env'))

def verify():
    conn = psycopg2.connect(
        dbname=os.getenv('DB_NAME','metaview_scraper'),
        user=os.getenv('DB_USER','scraper_user'),
        password=os.getenv('DB_PASSWORD','scraper_password'),
        host=os.getenv('DB_HOST','localhost'),
        port=os.getenv('DB_PORT','5433')
    )
    cur = conn.cursor()
    
    print("=== AUTOMATED TESTS ===")
    
    # 5. Row count parity
    cur.execute("SELECT COUNT(*) FROM candidates_upgraded")
    upgraded_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM candidate_profiles_parsed")
    parsed_count = cur.fetchone()[0]
    print(f"Row count parity: Upgraded={upgraded_count}, Parsed={parsed_count} -> {'PASS' if upgraded_count == parsed_count else 'FAIL'}")
    
    # 3. Feature sanity
    cur.execute("""
        SELECT COUNT(*) FROM candidate_features_v2 
        WHERE flight_risk_ratio < 0 
           OR career_velocity < 0 
           OR tenure_stability_score < 0 
           OR tenure_stability_score > 1
    """)
    invalid_features = cur.fetchone()[0]
    print(f"Feature sanity: Invalid rows={invalid_features} -> {'PASS' if invalid_features == 0 else 'FAIL'}")
    
    # 4. Embedding drift
    cur.execute("""
        SELECT COUNT(*) FROM candidate_features_v2 
        WHERE semantic_drift_score < 0 OR semantic_drift_score > 2
    """)
    invalid_drift = cur.fetchone()[0]
    print(f"Embedding drift sanity: Invalid rows={invalid_drift} -> {'PASS' if invalid_drift == 0 else 'FAIL'}")
    
    print("\n=== MANUAL VERIFICATION ===")
    
    # Matteo Turchetta
    cur.execute("""
        SELECT name, current_company, is_mover, current_tenure_months, flight_risk_ratio, semantic_drift_score, experience_json 
        FROM candidates_data_science_use_v2 
        WHERE name ILIKE '%Matteo Turchetta%' LIMIT 1
    """)
    matteo = cur.fetchone()
    if matteo:
        print(f"Matteo Turchetta Profile:")
        print(f"  Name: {matteo[0]}")
        print(f"  Company: {matteo[1]}")
        print(f"  Is Mover: {matteo[2]}")
        print(f"  Current Tenure (censored): {matteo[3]} months")
        print(f"  Flight Risk Ratio: {matteo[4]}")
        print(f"  Semantic Drift Score: {matteo[5]}")
        exp = matteo[6]
        if exp and len(exp) > 0:
            print(f"  Latest Role in Parsed JSON: {exp[0]['company']} (Is Current: {exp[0]['is_current_company']})")
            if len(exp) > 1:
                print(f"  Previous Role in Parsed JSON: {exp[1]['company']}")
    else:
        print("Matteo Turchetta not found in DB.")
        
    print("\n=== LEAKAGE TEST (MOVERS) ===")
    # 2. Leakage test for Movers
    cur.execute("""
        SELECT f.profile_url, f.name, f.current_tenure_months, p.experience_json
        FROM candidate_features_v2 f
        JOIN candidate_profiles_parsed p ON f.profile_url = p.profile_url
        WHERE f.is_mover = 1 AND p.experience_json IS NOT NULL
        LIMIT 3
    """)
    movers = cur.fetchall()
    for m in movers:
        name = m[1]
        censored_tenure = m[2]
        exp = m[3]
        if exp and len(exp) > 1:
            actual_current_tenure = exp[0].get('total_tenure_months', 0)
            actual_prev_tenure = exp[1].get('total_tenure_months', 0)
            print(f"Mover: {name}")
            print(f"  Actual Current Role Tenure: {actual_current_tenure} months")
            print(f"  Actual Prev Role Tenure: {actual_prev_tenure} months")
            print(f"  Censored Features Tenure: {censored_tenure} months")
            # For a mover, the censored tenure should match the PREVIOUS role's tenure, NOT the current role's tenure.
            if abs(censored_tenure - actual_prev_tenure) <= 1:
                print("  -> PASS (Censored tenure matches previous role!)")
            else:
                print(f"  -> FAIL (Censored={censored_tenure}, Current={actual_current_tenure}, Prev={actual_prev_tenure})")
        else:
            print(f"Mover {name} doesn't have enough history to verify.")
            
    cur.close()
    conn.close()

if __name__ == '__main__':
    verify()
