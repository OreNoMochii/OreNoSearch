#!/usr/bin/env python3
"""
Translate company names in companies_analyzed to Japanese using NVIDIA API.
Uses model: gpt-oss-120B via OpenAI-compatible endpoint.
Outputs: kanji (when appropriate), katakana, or hiragana translations.
"""

import os
import sys
import json
import time
import re
import psycopg2
from psycopg2.extras import execute_batch
from dotenv import load_dotenv
import requests

# Load env
env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
load_dotenv(dotenv_path=env_path)

NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY")
NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
MODEL = "openai/gpt-oss-120b"
BATCH_SIZE = 40  # companies per API call
RATE_LIMIT_DELAY = 1.0  # seconds between API calls


def get_db_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        port=os.getenv("DB_PORT", "5433")
    )


def ensure_name_ja_column(conn):
    """Add name_ja column if it doesn't exist."""
    with conn.cursor() as cur:
        cur.execute("""
            DO $$ 
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'companies_analyzed' AND column_name = 'name_ja'
                ) THEN
                    ALTER TABLE companies_analyzed ADD COLUMN name_ja TEXT;
                END IF;
            END $$;
        """)
    conn.commit()
    print("✓ Ensured name_ja column exists")


def is_already_japanese(name):
    """Check if the name already contains Japanese characters (kanji/katakana/hiragana)."""
    if not name:
        return False
    # Match hiragana, katakana, CJK unified ideographs, or fullwidth chars
    return bool(re.search(r'[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]', name))


def is_not_a_company(name):
    """Skip entries that are clearly not company names."""
    if not name:
        return True
    skip_patterns = [
        r'^\s*$',
        r'^↳',  # role lines
        r', Japan$',  # locations
        r'Prefecture',
        r'^Freelance',
        r'^Self[- ]?[Ee]mployed',
        r'^N/A',
        r'^\+\s*\d+\s*more',
    ]
    for pat in skip_patterns:
        if re.search(pat, name):
            return True
    return False


def translate_batch(names, retry_count=3):
    """
    Send a batch of company names to NVIDIA API for Japanese translation.
    Returns a dict of {english_name: japanese_translation}.
    """
    # Build the numbered list for the prompt
    numbered_list = "\n".join(f"{i+1}. {name}" for i, name in enumerate(names))
    
    prompt = f"""You are a professional Japanese translator specializing in company names.

Translate each company name below into its official Japanese name. Follow these rules:
1. If the company has a well-known official Japanese name (e.g., "Microsoft" → "マイクロソフト"), use it.
2. For companies without an official Japanese name, transliterate to katakana (e.g., "Accenture" → "アクセンチュア").
3. For Japanese companies written in romaji, convert back to their original kanji/kana form (e.g., "Rakuten" → "楽天").
4. Keep abbreviations like Inc., Corp., Ltd., Co. out of the translation unless the official Japanese name includes them (e.g., 株式会社).
5. If the name is already in Japanese (kanji/katakana/hiragana), return it as-is.
6. For generic/nonsensical entries (locations, job titles, "Unknown"), return "SKIP".

Return ONLY a JSON object mapping the number to the Japanese translation. Example:
{{"1": "マイクロソフト", "2": "アクセンチュア", "3": "SKIP"}}

Company names to translate:
{numbered_list}"""

    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are a precise translator. Return only valid JSON."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.1,
        "max_tokens": 4096,
    }
    
    for attempt in range(retry_count):
        try:
            resp = requests.post(NVIDIA_API_URL, headers=headers, json=payload, timeout=60)
            
            if resp.status_code == 429:
                wait_time = min(2 ** (attempt + 1), 30)
                print(f"  ⏳ Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
                continue
                
            resp.raise_for_status()
            
            content = resp.json()["choices"][0]["message"]["content"].strip()
            
            # Extract JSON from the response (handle markdown code blocks)
            json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', content)
            if json_match:
                content = json_match.group(1)
            
            translations = json.loads(content)
            
            # Map back to original names
            result = {}
            for i, name in enumerate(names):
                key = str(i + 1)
                if key in translations and translations[key] != "SKIP":
                    result[name] = translations[key]
                    
            return result
            
        except json.JSONDecodeError as e:
            print(f"  ⚠ JSON parse error on attempt {attempt+1}: {e}")
            print(f"  Raw content: {content[:200]}...")
            if attempt < retry_count - 1:
                time.sleep(2)
        except requests.exceptions.RequestException as e:
            print(f"  ⚠ API error on attempt {attempt+1}: {e}")
            if attempt < retry_count - 1:
                time.sleep(2 ** (attempt + 1))
    
    print(f"  ✗ Failed to translate batch after {retry_count} attempts")
    return {}


def main():
    conn = get_db_connection()
    ensure_name_ja_column(conn)
    
    # Fetch companies that need translation (no name_ja yet)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name FROM companies_analyzed 
            WHERE name_ja IS NULL 
            ORDER BY id
        """)
        rows = cur.fetchall()
    
    print(f"Found {len(rows)} companies needing translation")
    
    # Filter out already-Japanese names and non-companies
    to_translate = []
    auto_set = []  # Companies that are already in Japanese — just copy name to name_ja
    skip_ids = []
    
    for row_id, name in rows:
        if is_not_a_company(name):
            skip_ids.append(row_id)
        elif is_already_japanese(name):
            auto_set.append((name, row_id))
        else:
            to_translate.append((row_id, name))
    
    print(f"  → {len(auto_set)} already in Japanese (will copy name → name_ja)")
    print(f"  → {len(to_translate)} need API translation")
    print(f"  → {len(skip_ids)} skipped (not company names)")
    
    # Auto-set Japanese names
    if auto_set:
        with conn.cursor() as cur:
            execute_batch(cur, 
                "UPDATE companies_analyzed SET name_ja = %s WHERE id = %s",
                auto_set
            )
        conn.commit()
        print(f"✓ Auto-set {len(auto_set)} Japanese names")
    
    # Mark skipped entries
    if skip_ids:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE companies_analyzed SET name_ja = 'SKIP' WHERE id = ANY(%s)",
                (skip_ids,)
            )
        conn.commit()
        print(f"✓ Marked {len(skip_ids)} non-company entries as SKIP")
    
    # Translate in batches
    total_batches = (len(to_translate) + BATCH_SIZE - 1) // BATCH_SIZE
    total_translated = 0
    
    for batch_idx in range(0, len(to_translate), BATCH_SIZE):
        batch = to_translate[batch_idx:batch_idx + BATCH_SIZE]
        batch_num = batch_idx // BATCH_SIZE + 1
        
        names = [name for _, name in batch]
        id_map = {name: row_id for row_id, name in batch}
        
        print(f"\n[Batch {batch_num}/{total_batches}] Translating {len(names)} names...")
        
        translations = translate_batch(names)
        
        if translations:
            updates = [(ja_name, id_map[en_name]) for en_name, ja_name in translations.items()]
            with conn.cursor() as cur:
                execute_batch(cur,
                    "UPDATE companies_analyzed SET name_ja = %s WHERE id = %s",
                    updates
                )
            conn.commit()
            total_translated += len(updates)
            print(f"  ✓ Translated {len(updates)}/{len(names)} names")
            
            # Show a few examples
            for en, ja in list(translations.items())[:3]:
                print(f"    {en} → {ja}")
        else:
            print(f"  ✗ No translations returned for this batch")
        
        time.sleep(RATE_LIMIT_DELAY)
    
    print(f"\n{'='*50}")
    print(f"Done! Translated {total_translated} company names total.")
    
    # Show summary
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM companies_analyzed WHERE name_ja IS NOT NULL AND name_ja != 'SKIP'")
        filled = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM companies_analyzed WHERE name_ja IS NULL")
        remaining = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM companies_analyzed")
        total = cur.fetchone()[0]
    
    print(f"Coverage: {filled}/{total} ({filled/total*100:.1f}%) companies have Japanese names")
    if remaining > 0:
        print(f"Remaining: {remaining} companies still need translation (rerun to retry)")
    
    conn.close()


if __name__ == "__main__":
    main()
