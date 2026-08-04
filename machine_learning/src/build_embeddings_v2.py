import os
import json
import asyncio
import aiohttp
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from tqdm.asyncio import tqdm

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env'))

# We use DeepInfra or NVIDIA for Qwen3-Embedding-8B
API_BASE_URL = os.getenv('EMBEDDING_API_BASE', "https://api.deepinfra.com/v1/openai")
API_KEY = os.getenv('DEEPINFRA_API_KEY', os.getenv('OPENAI_API_KEY', ''))
MODEL_NAME = "Qwen/Qwen3-Embedding-8B-batch" # DeepInfra uses the exact HuggingFace model ID usually

CONCURRENCY = 4
BATCH_SIZE = 50

def cosine_similarity(v1, v2):
    if not v1 or not v2: return 0.0
    v1 = np.array(v1)
    v2 = np.array(v2)
    norm1 = np.linalg.norm(v1)
    norm2 = np.linalg.norm(v2)
    if norm1 == 0 or norm2 == 0: return 0.0
    return float(np.dot(v1, v2) / (norm1 * norm2))

async def embed_texts(session, texts, max_retries=3):
    if not texts: return []
    payload = {
        "model": MODEL_NAME,
        "input": texts,
        "encoding_format": "float"
    }
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    for attempt in range(max_retries):
        try:
            async with session.post(f"{API_BASE_URL}/embeddings", json=payload, headers=headers, timeout=30) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    # ensure order
                    embeddings = [None] * len(texts)
                    for item in data['data']:
                        embeddings[item['index']] = item['embedding']
                    return embeddings
                elif resp.status in [429, 500, 502, 503, 504]:
                    await asyncio.sleep(2 ** attempt)
                else:
                    print(f"Embedding error {resp.status}: {await resp.text()}")
                    return [None] * len(texts)
        except Exception as e:
            await asyncio.sleep(2 ** attempt)
            
    return [None] * len(texts)

async def worker(queue, session, conn_pool, pbar):
    while True:
        batch = await queue.get()
        if batch is None: break
        
        # Build text chunks
        all_texts = []
        role_map = [] # maps flat index to (profile_url, stay_order)
        
        for row in batch:
            profile_url = row['profile_url']
            exp_json = row.get('experience_json')
            exp_text = row.get('experience')
            skills_str = row.get('technical_skills', '')
            
            stays = []
            
            if exp_json:
                if isinstance(exp_json, str): 
                    try:
                        exp_json = json.loads(exp_json)
                    except:
                        pass
                
                if isinstance(exp_json, list):
                    for stay in exp_json:
                        if not isinstance(stay, dict): continue
                        roles = stay.get('roles', [])
                        if not roles: continue
                        # Combine role descriptions
                        role_text = f"Company: {stay.get('company', '')}. "
                        for r in roles:
                            role_text += f"Role: {r.get('title', '')}. {r.get('description', '')} "
                        if skills_str:
                            role_text += f"Skills: {skills_str}"
                        stays.append(role_text)
            
            if not stays and exp_text:
                # Fallback to plain text experience
                for stay_text in exp_text.split('\n\n'):
                    if stay_text.strip():
                        text = stay_text.strip()
                        if skills_str:
                            text += f"\nSkills: {skills_str}"
                        stays.append(text)
                        
            if not stays:
                continue
                
            for stay_idx, role_text in enumerate(stays):
                # Truncate to ~4000 chars roughly to avoid token limits
                all_texts.append(role_text[:4000])
                role_map.append((profile_url, stay_idx, role_text))
                
        if all_texts:
            embeddings = await embed_texts(session, all_texts)
            
            # Group by profile_url to compute drift
            profile_embeddings = {}
            insert_batch = []
            
            for i, emb in enumerate(embeddings):
                if emb is None: continue
                profile_url, stay_order, role_text = role_map[i]
                if profile_url not in profile_embeddings:
                    profile_embeddings[profile_url] = {}
                profile_embeddings[profile_url][stay_order] = emb
                
                insert_batch.append((profile_url, stay_order, role_text, emb))
                
            # Write to DB
            conn = conn_pool.getconn()
            cursor = conn.cursor()
            
            # Insert embeddings
            if insert_batch:
                insert_sql = """
                    INSERT INTO candidate_role_embeddings (profile_url, stay_order, role_text, embedding)
                    VALUES (%s, %s, %s, %s)
                """
                cursor.executemany(insert_sql, insert_batch)
                
            # Compute and update drift
            drift_updates = []
            for profile_url, stay_embs in profile_embeddings.items():
                if 0 in stay_embs and 1 in stay_embs:
                    drift = 1.0 - cosine_similarity(stay_embs[0], stay_embs[1])
                    drift_updates.append((drift, profile_url))
                    
            if drift_updates:
                drift_sql = "UPDATE candidate_features_v2 SET semantic_drift_score = %s WHERE profile_url = %s"
                cursor.executemany(drift_sql, drift_updates)
                
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
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    
    # We only process profiles that don't have embeddings yet
    cursor.execute("SELECT DISTINCT profile_url FROM candidate_role_embeddings")
    done_urls = {row['profile_url'] for row in cursor.fetchall()}
    
    # Join upgraded candidates with parsed profiles to get experience_json
    cursor.execute("""
        SELECT u.profile_url, p.experience_json, u.experience, u.skills as technical_skills
        FROM candidates_upgraded u
        LEFT JOIN candidate_profiles_parsed p ON u.profile_url = p.profile_url
    """)
    all_rows = cursor.fetchall()
    cursor.close()
    pg_pool.putconn(conn)
    
    to_process = []
    for r in all_rows:
        if r['profile_url'] in done_urls:
            continue
            
        exp_json = r.get('experience_json')
        exp_text = r.get('experience')
        
        has_roles = False
        
        if exp_json:
            if isinstance(exp_json, str):
                try:
                    exp_json = json.loads(exp_json)
                except:
                    pass
            if isinstance(exp_json, list) and len(exp_json) > 0:
                for stay in exp_json:
                    if isinstance(stay, dict) and stay.get('roles'):
                        has_roles = True
                        break
                        
        if not has_roles and exp_text and exp_text.strip():
            has_roles = True
            
        if has_roles:
            to_process.append(r)
    
    print(f"Total profiles in candidates_upgraded: {len(all_rows)}")
    print(f"Already done in embeddings table: {len(done_urls)}")
    print(f"To process: {len(to_process)}")
    
    if not to_process:
        print("All done!")
        return
        
    queue = asyncio.Queue()
    for i in range(0, len(to_process), BATCH_SIZE):
        queue.put_nowait(to_process[i:i+BATCH_SIZE])
        
    for _ in range(CONCURRENCY):
        queue.put_nowait(None)
        
    pbar = tqdm(total=len(to_process))
    async with aiohttp.ClientSession() as session:
        workers = [asyncio.create_task(worker(queue, session, pg_pool, pbar)) for _ in range(CONCURRENCY)]
        await asyncio.gather(*workers)
        
    pbar.close()
    pg_pool.closeall()
    print("Embedding complete!")

def main():
    asyncio.run(main_async())

if __name__ == "__main__":
    main()
