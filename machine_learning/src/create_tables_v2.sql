-- DDL for Metaview Scraper Machine Learning Pipeline v2

-- 1. candidate_profiles_parsed
CREATE TABLE IF NOT EXISTS candidate_profiles_parsed (
    profile_url       TEXT PRIMARY KEY,
    name              TEXT,
    headline          TEXT,
    location          TEXT,
    current_company   TEXT,
    scraped_at        TIMESTAMP,
    experience_json   JSONB NOT NULL,
    education_json    JSONB,
    parse_version     INTEGER DEFAULT 1,
    parsed_at         TIMESTAMP DEFAULT NOW()
);

-- 2. candidate_extracted_skills
CREATE TABLE IF NOT EXISTS candidate_extracted_skills (
    profile_url       TEXT PRIMARY KEY,
    technical_skills  JSONB,
    domain_expertise  JSONB,
    tools_platforms   JSONB,
    soft_skills       JSONB,
    languages         JSONB,
    certifications    JSONB,
    model_used        TEXT,
    extracted_at      TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (profile_url) REFERENCES candidate_profiles_parsed(profile_url)
);

-- 3. candidate_career_events
CREATE TABLE IF NOT EXISTS candidate_career_events (
    id                SERIAL PRIMARY KEY,
    profile_url       TEXT NOT NULL,
    company           TEXT,
    company_normalized TEXT,
    stay_order        INTEGER,
    start_approx      DATE,
    end_approx        DATE,
    duration_months   REAL,
    is_current        BOOLEAN,
    left_job          INTEGER,
    num_internal_roles INTEGER,
    max_seniority_tier INTEGER,
    min_seniority_tier INTEGER,
    seniority_delta    INTEGER,
    latest_role_title  TEXT,
    is_founder_ceo     BOOLEAN,
    prior_total_exp_months    REAL,
    prior_num_companies       INTEGER,
    prior_avg_tenure_months   REAL,
    prior_median_tenure_months REAL,
    prior_max_tenure_months   REAL,
    prior_min_tenure_months   REAL,
    prior_tenure_std_months   REAL,
    career_velocity           REAL,
    tenure_ratio              REAL,
    seniority_stagnation_months REAL,
    is_tier1_company          BOOLEAN,
    is_boomerang              BOOLEAN,
    role_description_hash     TEXT,
    FOREIGN KEY (profile_url) REFERENCES candidate_profiles_parsed(profile_url)
);
CREATE INDEX IF NOT EXISTS idx_cce_profile ON candidate_career_events(profile_url);
CREATE INDEX IF NOT EXISTS idx_cce_current ON candidate_career_events(is_current);

-- 4. candidate_features_v2
CREATE TABLE IF NOT EXISTS candidate_features_v2 (
    profile_url               TEXT PRIMARY KEY,
    name                      TEXT,
    scraped_at                TIMESTAMP,
    is_mover                  INTEGER,
    current_tenure_months     REAL,
    current_company           TEXT,
    current_seniority_tier    INTEGER,
    is_founder_ceo            BOOLEAN,
    total_exp_months          REAL,
    num_companies             INTEGER,
    avg_tenure_months         REAL,
    median_tenure_months      REAL,
    tenure_std_months         REAL,
    max_tenure_months         REAL,
    min_tenure_months         REAL,
    career_velocity           REAL,
    tenure_stability_score    REAL,
    seniority_stagnation_months REAL,
    flight_risk_ratio         REAL,
    company_size_band         TEXT,
    company_flight_risk       TEXT,
    company_reputation        TEXT,
    is_tier1                  BOOLEAN,
    is_boomerang              BOOLEAN,
    has_email                 BOOLEAN,
    has_advanced_degree       BOOLEAN,
    summary_word_count        INTEGER,
    experience_word_count     INTEGER,
    num_concurrent_roles      INTEGER,
    semantic_drift_score      REAL,
    FOREIGN KEY (profile_url) REFERENCES candidate_profiles_parsed(profile_url)
);

-- 5. candidate_role_embeddings
CREATE TABLE IF NOT EXISTS candidate_role_embeddings (
    id            SERIAL PRIMARY KEY,
    profile_url   TEXT NOT NULL,
    stay_order    INTEGER,
    role_text     TEXT,
    embedding     REAL[],
    created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cre_profile ON candidate_role_embeddings(profile_url);

-- 6. candidates_data_science_use_v2
CREATE TABLE IF NOT EXISTS candidates_data_science_use_v2 (
    profile_url               TEXT PRIMARY KEY,
    name                      TEXT,
    headline                  TEXT,
    location                  TEXT,
    current_company           TEXT,
    scraped_at                TIMESTAMP,
    experience_json           JSONB,
    education_json            JSONB,
    skills_json               JSONB,
    is_mover                  INTEGER,
    current_tenure_months     REAL,
    total_exp_months          REAL,
    num_companies             INTEGER,
    avg_tenure_months         REAL,
    median_tenure_months      REAL,
    tenure_std_months         REAL,
    career_velocity           REAL,
    tenure_stability_score    REAL,
    seniority_stagnation_months REAL,
    flight_risk_ratio         REAL,
    current_seniority_tier    INTEGER,
    is_founder_ceo            BOOLEAN,
    is_tier1                  BOOLEAN,
    is_boomerang              BOOLEAN,
    has_email                 BOOLEAN,
    has_advanced_degree       BOOLEAN,
    semantic_drift_score      REAL,
    num_concurrent_roles      INTEGER,
    company_flight_risk       TEXT,
    FOREIGN KEY (profile_url) REFERENCES candidate_profiles_parsed(profile_url)
);
