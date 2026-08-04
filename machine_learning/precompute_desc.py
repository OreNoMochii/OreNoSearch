import psycopg2
import os
import pandas as pd
import json
import numpy as np

def compute_desc_lengths():
    print("Connecting...")
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        port=os.getenv("DB_PORT", "5433")
    )
    
    query = """
    SELECT 
        cce.profile_url,
        cce.company,
        v2.experience_json
    FROM candidate_career_events cce
    JOIN candidates_data_science_use_v2 v2 ON cce.profile_url = v2.profile_url
    WHERE cce.duration_months > 0
    """
    
    print("Executing query in chunks...")
    chunks = pd.read_sql(query, conn, chunksize=5000)
    
    def get_len(row):
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

    all_results = []
    for i, chunk in enumerate(chunks):
        print(f"Processing chunk {i+1}...")
        chunk['log_stay_desc_len'] = np.log1p(chunk.apply(get_len, axis=1))
        all_results.append(chunk[['profile_url', 'company', 'log_stay_desc_len']])
        
    final_df = pd.concat(all_results, ignore_index=True)
    final_df.to_csv('desc_lengths.csv', index=False)
    print("Saved to desc_lengths.csv")
    conn.close()

if __name__ == '__main__':
    compute_desc_lengths()
