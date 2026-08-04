import os
import json
import asyncio
import aiohttp
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from tqdm.asyncio import tqdm

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env'))

NIM_API_KEY = os.getenv('NVIDIA_API_KEY', '')
if not NIM_API_KEY: NIM_API_KEY = os.getenv('OPENAI_API_KEY', '')
NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"
PRIMARY_MODEL = "google/gemma-4-31b-it"
FALLBACK_MODEL = "deepseek-ai/deepseek-v4-flash"

CONCURRENCY = 2
BATCH_SIZE = 1

PROMPT = """
Extract all technical skills, tools, programming languages, frameworks,
and domain expertise from this candidate's experience.
Return ONLY a JSON object with:
{
  "technical_skills": ["string", ...],
  "domain_expertise": ["string", ...],
  "tools_platforms": ["string", ...],
  "soft_skills": ["string", ...],
  "languages": ["string", ...],
  "certifications": ["string", ...]
}
"""

async def extract_skills_for_profile(session, profile_url, exp_json_data, max_retries=5):
    try:
        exp_data = exp_json_data if isinstance(exp_json_data, list) else json.loads(exp_json_data)
        text_blobs = []
        for stay in exp_data:
            for role in stay.get('roles', []):
                if role.get('title'): text_blobs.append(f"Role: {role['title']}")
                if role.get('description'): text_blobs.append(role['description'])
        
        full_text = "\n".join(text_blobs)[:3000]
        if not full_text.strip():
            return profile_url, None, "empty"
            
        payload = {
            "model": PRIMARY_MODEL,
            "messages": [
                {"role": "system", "content": PROMPT},
                {"role": "user", "content": f"CANDIDATE EXPERIENCE:\n{full_text}"}
            ],
            "max_tokens": 1024,
            "temperature": 0.0
        }
        
        headers = {
            "Authorization": f"Bearer {NIM_API_KEY}",
            "Content-Type": "application/json"
        }
        
        # Primary call
        for attempt in range(max_retries):
            try:
                async with session.post(f"{NIM_BASE_URL}/chat/completions", json=payload, headers=headers, timeout=60) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        content = data['choices'][0]['message']['content']
                        return profile_url, content, PRIMARY_MODEL
                    elif resp.status in [429, 500, 502, 503, 504]:
                        print(f"Primary HTTP {resp.status}: {await resp.text()}")
                        if attempt < max_retries - 1:
                            await asyncio.sleep((2 ** attempt) + 1)
                        else:
                            raise Exception(f"HTTP {resp.status}")
                    else:
                        print(f"Primary Error {resp.status}: {await resp.text()}")
                        raise Exception(f"HTTP {resp.status}")
            except Exception as e:
                print(f"Primary Exception: {e}")
                if "HTTP" in str(e) and resp.status not in [429, 500, 502, 503, 504]:
                    pass # Break out if it's a hard error
                elif attempt < max_retries - 1:
                    await asyncio.sleep((2 ** attempt) + 1)
                else:
                    break # go to fallback
            
        # Fallback call
        payload["model"] = FALLBACK_MODEL
        for attempt in range(max_retries):
            try:
                async with session.post(f"{NIM_BASE_URL}/chat/completions", json=payload, headers=headers, timeout=60) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        content = data['choices'][0]['message']['content']
                        return profile_url, content, FALLBACK_MODEL
                    elif resp.status in [429, 500, 502, 503, 504]:
                        print(f"Fallback HTTP {resp.status}: {await resp.text()}")
                        if attempt < max_retries - 1:
                            await asyncio.sleep((2 ** attempt) + 1)
                        else:
                            return profile_url, None, "error"
                    else:
                        print(f"Fallback Error {resp.status}: {await resp.text()}")
                        return profile_url, None, "error"
            except Exception as e:
                print(f"Fallback Exception: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep((2 ** attempt) + 1)
                else:
                    return profile_url, None, "error"
            
        return profile_url, None, "error"
        
    except Exception as e:
        print(f"Outer Exception: {e}")
        return profile_url, None, "error"

def parse_llm_json(content):
    if not content: return None
    try:
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
        return json.loads(content.strip())
    except:
        return None

async def worker(queue, session, conn_pool, pbar):
    while True:
        batch = await queue.get()
        if batch is None: break
        
        tasks = []
        for profile_url, exp_json in batch:
            tasks.append(extract_skills_for_profile(session, profile_url, exp_json))
            
        results = await asyncio.gather(*tasks)
        
        conn = conn_pool.getconn()
        cursor = conn.cursor()
        
        insert_sql = """
            INSERT INTO candidate_extracted_skills 
            (profile_url, technical_skills, domain_expertise, tools_platforms, soft_skills, languages, certifications, model_used)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (profile_url) DO UPDATE SET
                technical_skills = EXCLUDED.technical_skills,
                domain_expertise = EXCLUDED.domain_expertise,
                tools_platforms = EXCLUDED.tools_platforms,
                soft_skills = EXCLUDED.soft_skills,
                languages = EXCLUDED.languages,
                certifications = EXCLUDED.certifications,
                model_used = EXCLUDED.model_used,
                extracted_at = NOW()
        """
        
        insert_batch = []
        for profile_url, content, model_used in results:
            if content and model_used != "empty" and model_used != "error":
                parsed = parse_llm_json(content)
                if parsed:
                    insert_batch.append((
                        profile_url,
                        json.dumps(parsed.get('technical_skills', [])),
                        json.dumps(parsed.get('domain_expertise', [])),
                        json.dumps(parsed.get('tools_platforms', [])),
                        json.dumps(parsed.get('soft_skills', [])),
                        json.dumps(parsed.get('languages', [])),
                        json.dumps(parsed.get('certifications', [])),
                        model_used
                    ))
            elif model_used == "empty" or model_used == "error":
                insert_batch.append((
                    profile_url, '[]', '[]', '[]', '[]', '[]', '[]', model_used
                ))
                
        if insert_batch:
            cursor.executemany(insert_sql, insert_batch)
            conn.commit()
            
        cursor.close()
        conn_pool.putconn(conn)
        
        pbar.update(len(batch))
        queue.task_done()

async def main_async():
    from psycopg2 import pool
    pg_pool = pool.SimpleConnectionPool(
        minconn=1, maxconn=CONCURRENCY+2,
        dbname=os.getenv('DB_NAME','metaview_scraper'),
        user=os.getenv('DB_USER','scraper_user'),
        password=os.getenv('DB_PASSWORD','scraper_password'),
        host=os.getenv('DB_HOST','localhost'),
        port=os.getenv('DB_PORT','5433')
    )
    
    conn = pg_pool.getconn()
    cursor = conn.cursor()
    cursor.execute("SELECT profile_url FROM candidate_extracted_skills")
    done_urls = {row[0] for row in cursor.fetchall()}
    
    cursor.execute("SELECT profile_url, experience_json FROM candidate_profiles_parsed")
    all_rows = cursor.fetchall()
    cursor.close()
    pg_pool.putconn(conn)
    
    to_process = [r for r in all_rows if r[0] not in done_urls]
    print(f"Total profiles: {len(all_rows)}")
    print(f"Already done: {len(done_urls)}")
    print(f"To process: {len(to_process)}")
    
    # Process all remaining profiles
    
    if not to_process:
        print("All done!")
        return
        
    queue = asyncio.Queue()
    for i in range(0, len(to_process), BATCH_SIZE):
        queue.put_nowait(to_process[i:i+BATCH_SIZE])
        
    for _ in range(CONCURRENCY):
        queue.put_nowait(None) # sentinels
        
    pbar = tqdm(total=len(to_process))
    async with aiohttp.ClientSession() as session:
        workers = [asyncio.create_task(worker(queue, session, pg_pool, pbar)) for _ in range(CONCURRENCY)]
        await asyncio.gather(*workers)
        
    pbar.close()
    pg_pool.closeall()
    print("Extraction complete!")

def main():
    asyncio.run(main_async())

if __name__ == "__main__":
    main()
