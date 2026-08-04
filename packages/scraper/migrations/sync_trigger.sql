CREATE OR REPLACE FUNCTION sync_candidates_search()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        DELETE FROM candidates_search WHERE profile_url = OLD.profile_url;
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE' OR TG_OP = 'INSERT') THEN
        INSERT INTO candidates_search (
            name, profile_url, headline, location, current_company, summary, 
            email, phone_number, experience, latest_role, education, skills, 
            language, licenses, scraped_at
        ) VALUES (
            NEW.name, NEW.profile_url, NEW.headline, NEW.location, NEW.current_company, NEW.summary, 
            NEW.email, NEW.phone_number, NEW.experience, NEW.latest_role, NEW.education, NEW.skills, 
            NEW.language, NEW.licenses, NEW.scraped_at
        )
        ON CONFLICT (profile_url) DO UPDATE SET
            name = EXCLUDED.name,
            headline = EXCLUDED.headline,
            location = EXCLUDED.location,
            current_company = EXCLUDED.current_company,
            summary = EXCLUDED.summary,
            email = EXCLUDED.email,
            phone_number = EXCLUDED.phone_number,
            experience = EXCLUDED.experience,
            latest_role = EXCLUDED.latest_role,
            education = EXCLUDED.education,
            skills = EXCLUDED.skills,
            language = EXCLUDED.language,
            licenses = EXCLUDED.licenses,
            scraped_at = EXCLUDED.scraped_at;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidates_search_sync_trigger ON candidates_upgraded;

CREATE TRIGGER candidates_search_sync_trigger
AFTER INSERT OR UPDATE OR DELETE ON candidates_upgraded
FOR EACH ROW EXECUTE FUNCTION sync_candidates_search();
