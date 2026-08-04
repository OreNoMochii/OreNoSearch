-- 1. Create a fresh copy of the table as requested
DROP TABLE IF EXISTS candidates_search;

CREATE TABLE candidates_search AS 
SELECT * FROM candidates_upgraded;

-- 2. Add primary key
ALTER TABLE candidates_search ADD PRIMARY KEY (profile_url);

-- 3. Add generated country column
ALTER TABLE candidates_search ADD COLUMN country text GENERATED ALWAYS AS (
  CASE 
    WHEN location ILIKE ANY(ARRAY['%japan%','%tokyo%','%osaka%','%kyoto%',
         '%yokohama%','%saitama%','%chiba%','%kanagawa%','%nagoya%']) THEN 'Japan'
    WHEN location ILIKE '%singapore%' THEN 'Singapore'
    WHEN location ILIKE ANY(ARRAY['%vietnam%','%ho chi minh%',
         '%hanoi%','%da nang%']) THEN 'Vietnam'
    WHEN location ILIKE ANY(ARRAY['%malaysia%','%kuala lumpur%','%selangor%',
         '%penang%','%cyberjaya%','%shah alam%','%subang%','%petaling%']) THEN 'Malaysia'
    ELSE 'Other'
  END
) STORED;

-- 4. Add search_vector column
ALTER TABLE candidates_search ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('english', 
    regexp_replace(
      coalesce(name, '') || ' ' || 
      coalesce(headline, '') || ' ' || 
      coalesce(latest_role, '') || ' ' || 
      coalesce(current_company, '') || ' ' || 
      coalesce(experience, '') || ' ' || 
      coalesce(summary, ''),
      'c\+\+', 'cpp_lang', 'ig'
    )
  )
) STORED;

-- 5. Create indexes
CREATE INDEX idx_candidates_search_country ON candidates_search(country);
CREATE INDEX idx_candidates_search_vector ON candidates_search USING GIN (search_vector);

-- 6. Add a simple experience months numeric column by extracting the first "X yr Y mo" pattern
-- (Optional, but makes server-side numeric filtering very fast)
-- If we can't reliably parse it via regex in SQL, we'll do it on the fly, but let's try a regex for 'yr' 
-- This creates a simple parsed value for months
ALTER TABLE candidates_search ADD COLUMN experience_months integer GENERATED ALWAYS AS (
  COALESCE(
    (NULLIF(substring(experience from '(?i)(\d+)\s*yr'), '')::integer * 12), 0
  ) + 
  COALESCE(
    (NULLIF(substring(experience from '(?i)(\d+)\s*mo'), '')::integer), 0
  )
) STORED;

CREATE INDEX idx_candidates_search_experience_months ON candidates_search(experience_months);
