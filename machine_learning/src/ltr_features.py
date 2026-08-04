import numpy as np

def cosine_similarity(v1, v2):
    if not v1 or not v2: return 0.0
    v1 = np.array(v1)
    v2 = np.array(v2)
    norm1 = np.linalg.norm(v1)
    norm2 = np.linalg.norm(v2)
    if norm1 == 0 or norm2 == 0: return 0.0
    return float(np.dot(v1, v2) / (norm1 * norm2))

def get_candidate_features(conn, profile_url):
    """
    Fetch the flight risk and pre-computed candidate features for the given profile.
    """
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM candidates_data_science_use_v2 WHERE profile_url = %s", (profile_url,))
    row = cursor.fetchone()
    cursor.close()
    return row

def get_candidate_embeddings(conn, profile_url):
    """
    Fetch all per-role embeddings for the candidate.
    """
    cursor = conn.cursor()
    cursor.execute("SELECT stay_order, embedding FROM candidate_role_embeddings WHERE profile_url = %s ORDER BY stay_order", (profile_url,))
    rows = cursor.fetchall()
    cursor.close()
    return {row[0]: row[1] for row in rows}

def compute_alignment_features(jd_embedding, jd_keywords, jd_tier, jd_years, candidate_data, candidate_embeddings):
    """
    Compute LTR alignment features between a JD and a candidate.
    """
    features = {}
    
    # 1. Semantic Cosine Similarity to Recent Role
    recent_emb = candidate_embeddings.get(0, None)
    features['jd_recent_role_cosine'] = cosine_similarity(jd_embedding, recent_emb) if recent_emb else 0.0
    
    # 2. Seniority Match
    c_tier = candidate_data.get('current_seniority_tier', 1)
    features['jd_seniority_match'] = 1.0 if abs(jd_tier - c_tier) <= 1 else 0.0
    
    # 3. Experience Match
    c_years = candidate_data.get('total_exp_months', 0) / 12.0
    if jd_years > 0:
        features['jd_exp_match'] = max(0.0, 1.0 - abs(jd_years - c_years) / jd_years)
    else:
        features['jd_exp_match'] = 1.0
        
    # 4. Domain Overlap (Skills)
    skills_json = candidate_data.get('skills_json', {})
    c_skills = set()
    for cat in ['technical_skills', 'domain_expertise', 'tools_platforms']:
        c_skills.update(skills_json.get(cat, []))
        
    c_skills_lower = {s.lower() for s in c_skills}
    jd_keywords_lower = {k.lower() for k in jd_keywords}
    
    if jd_keywords_lower:
        overlap = len(jd_keywords_lower.intersection(c_skills_lower))
        features['jd_skills_overlap'] = overlap / len(jd_keywords_lower)
    else:
        features['jd_skills_overlap'] = 0.0
        
    return features

def generate_ltr_vector(jd_features, candidate_row, alignment_features):
    """
    Concatenate candidate flight risk features with alignment features
    to produce the final vector for the LambdaMART model.
    """
    vector = [
        candidate_row.get('is_mover', 0),
        candidate_row.get('current_tenure_months', 0),
        candidate_row.get('total_exp_months', 0),
        candidate_row.get('num_companies', 0),
        candidate_row.get('avg_tenure_months', 0),
        candidate_row.get('career_velocity', 0),
        candidate_row.get('tenure_stability_score', 0),
        candidate_row.get('flight_risk_ratio', 0),
        candidate_row.get('semantic_drift_score', 0),
        
        alignment_features.get('jd_recent_role_cosine', 0),
        alignment_features.get('jd_seniority_match', 0),
        alignment_features.get('jd_exp_match', 0),
        alignment_features.get('jd_skills_overlap', 0)
    ]
    return vector
