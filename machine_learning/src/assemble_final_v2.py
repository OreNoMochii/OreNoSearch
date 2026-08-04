import os
import psycopg2
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env'))

def main():
    conn = psycopg2.connect(
        dbname=os.getenv('DB_NAME','metaview_scraper'),
        user=os.getenv('DB_USER','scraper_user'),
        password=os.getenv('DB_PASSWORD','scraper_password'),
        host=os.getenv('DB_HOST','localhost'),
        port=os.getenv('DB_PORT','5433')
    )
    conn.autocommit = True
    cursor = conn.cursor()
    
    print("Truncating final table...")
    cursor.execute("TRUNCATE TABLE candidates_data_science_use_v2")
    
    insert_sql = """
        INSERT INTO candidates_data_science_use_v2
        (profile_url, name, headline, location, current_company, scraped_at, 
         experience_json, education_json, skills_json,
         is_mover, current_tenure_months, total_exp_months, num_companies,
         avg_tenure_months, median_tenure_months, tenure_std_months, career_velocity,
         tenure_stability_score, seniority_stagnation_months, flight_risk_ratio,
         current_seniority_tier, is_founder_ceo, is_tier1, is_boomerang, has_email,
         has_advanced_degree, semantic_drift_score, num_concurrent_roles, company_flight_risk)
        SELECT 
            f.profile_url,
            f.name,
            p.headline,
            p.location,
            f.current_company,
            f.scraped_at,
            p.experience_json,
            p.education_json,
            COALESCE(
                jsonb_build_object(
                    'technical_skills', s.technical_skills,
                    'domain_expertise', s.domain_expertise,
                    'tools_platforms', s.tools_platforms,
                    'soft_skills', s.soft_skills,
                    'languages', s.languages,
                    'certifications', s.certifications
                ),
                '{}'::jsonb
            ) as skills_json,
            f.is_mover,
            f.current_tenure_months,
            f.total_exp_months,
            f.num_companies,
            f.avg_tenure_months,
            f.median_tenure_months,
            f.tenure_std_months,
            f.career_velocity,
            f.tenure_stability_score,
            f.seniority_stagnation_months,
            f.flight_risk_ratio,
            f.current_seniority_tier,
            f.is_founder_ceo,
            f.is_tier1,
            f.is_boomerang,
            f.has_email,
            f.has_advanced_degree,
            f.semantic_drift_score,
            f.num_concurrent_roles,
            f.company_flight_risk
        FROM candidate_features_v2 f
        JOIN candidate_profiles_parsed p ON f.profile_url = p.profile_url
        LEFT JOIN candidate_extracted_skills s ON f.profile_url = s.profile_url
    """
    
    print("Assembling candidates_data_science_use_v2...")
    cursor.execute(insert_sql)
    print(f"Inserted {cursor.rowcount} rows!")
    
    cursor.close()
    conn.close()

if __name__ == "__main__":
    main()
