EXPLAIN SELECT * FROM candidates_upgraded WHERE 
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
                ) @@ to_tsquery('english', 'ai & engineer');
