import os
import re
import json
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime
from dateutil.relativedelta import relativedelta
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env'))

DB_EN_TO_CANONICAL = {}
DB_JA_TO_CANONICAL = {}

def load_company_mappings(conn):
    global DB_EN_TO_CANONICAL, DB_JA_TO_CANONICAL
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    cursor.execute("SELECT name, name_ja FROM companies_analyzed WHERE name_ja IS NOT NULL AND name_ja != 'SKIP'")
    rows = cursor.fetchall()
    
    def _has_cjk(text):
        import unicodedata
        return any(unicodedata.category(c).startswith('Lo') for c in text if c.strip())
    
    for row in rows:
        en_name = row['name']
        ja_name = row['name_ja']
        if en_name and ja_name:
            canonical = en_name.lower().strip()
            if _has_cjk(en_name):
                ja_lower = en_name.lower().strip()
                DB_JA_TO_CANONICAL[ja_lower] = canonical
                ja_stripped = _strip_legal_suffixes(en_name).lower().strip()
                if ja_stripped:
                    DB_JA_TO_CANONICAL[ja_stripped] = canonical
            else:
                DB_EN_TO_CANONICAL[canonical] = canonical
                en_stripped = _strip_legal_suffixes(en_name).lower().strip()
                if en_stripped:
                    DB_EN_TO_CANONICAL[en_stripped] = canonical
            
            ja_lower = ja_name.lower().strip()
            DB_JA_TO_CANONICAL[ja_lower] = canonical
            ja_stripped = _strip_legal_suffixes(ja_name).lower().strip()
            if ja_stripped:
                DB_JA_TO_CANONICAL[ja_stripped] = canonical
    cursor.close()

def _strip_legal_suffixes(name):
    if not name: return ""
    normalized = name.strip()
    suffixes = ['（株）', '(株)', '株式会社', '合同会社', '有限会社', 'Co., Ltd.', 'Co.,Ltd.', 'Inc.', 'Corp.', 'Corporation', 'K.K.', 'G.K.', 'Ltd.', 'Limited']
    prefixes = ['株式会社', '日本']
    for suffix in suffixes:
        if normalized.endswith(suffix):
            normalized = normalized[:-len(suffix)].strip()
    for prefix in prefixes:
        if normalized.startswith(prefix) and len(normalized) > len(prefix):
            normalized = normalized[len(prefix):].strip()
    return normalized

def _normalize_company_name(name):
    if not name: return ""
    normalized = _strip_legal_suffixes(name)
    name_lower = name.lower().strip()
    norm_lower = normalized.lower().strip()
    
    for key in [name_lower, norm_lower]:
        if key in DB_EN_TO_CANONICAL: return DB_EN_TO_CANONICAL[key]
    for key in [name_lower, norm_lower]:
        if key in DB_JA_TO_CANONICAL: return DB_JA_TO_CANONICAL[key]
        
    jp_en_map = {
        'マイクロソフト': 'microsoft', 'アマゾン': 'amazon', 'グーグル': 'google', 'セールスフォース': 'salesforce',
        'オラクル': 'oracle', 'アップル': 'apple', '楽天': 'rakuten', 'ソニー': 'sony', 'パナソニック': 'panasonic',
        'トヨタ': 'toyota', 'ホンダ': 'honda', '日立': 'hitachi', '富士通': 'fujitsu', 'サイボウズ': 'cybozu',
        'メルカリ': 'mercari', 'リクルート': 'recruit', 'ソフトバンク': 'softbank', 'ファーストリテイリング': 'fast retailing',
        'ユニクロ': 'uniqlo', 'デロイト': 'deloitte', 'アクセンチュア': 'accenture', 'ベイン': 'bain',
        'マッキンゼー': 'mckinsey', 'ボストンコンサルティング': 'bcg', 'PwC': 'pwc', 'KPMG': 'kpmg',
        'エヌビディア': 'nvidia', 'メタ': 'meta', 'ネットフリックス': 'netflix', 'シスコ': 'cisco',
        'SAP': 'sap', 'IBM': 'ibm', 'インテル': 'intel', 'デル': 'dell', 'HP': 'hp', 'NEC': 'nec',
        'NTT': 'ntt', 'KDDI': 'kddi', 'LINE': 'line', 'ヤフー': 'yahoo', 'PayPay': 'paypay', 'Zホールディングス': 'z holdings',
    }
    for jp_name, en_name in jp_en_map.items():
        if jp_name in normalized or jp_name in name:
            return en_name
    return normalized.lower().strip()

def _should_merge_companies(name_a, name_b):
    if not name_a or not name_b: return False
    norm_a = _normalize_company_name(name_a)
    norm_b = _normalize_company_name(name_b)
    if norm_a == norm_b: return True
    if len(norm_a) >= 3 and len(norm_b) >= 3:
        if norm_a in norm_b or norm_b in norm_a: return True
    return False

def parse_duration(d_str):
    m_total = 0.0
    yr_m = re.search(r'(\d+)\s*yr', d_str)
    if yr_m: m_total += float(yr_m.group(1)) * 12.0
    mo_m = re.search(r'(\d+)\s*mo', d_str)
    if mo_m: m_total += float(mo_m.group(1))
    return m_total

def get_tier(title):
    TIER4 = re.compile(r'\b(chief|ceo|cto|cfo|coo|cmo|cro|cio|cpo|cso|president|founder|co-founder|executive\s+director|代表取締役|執行役員|取締役|社長|副社長)\b', re.IGNORECASE)
    TIER3 = re.compile(r'\b(vice\s+president|senior\s+vice\s+president|svp|evp|avp|managing\s+director|general\s+manager|partner|director|head\s+of|regional\s+head|country\s+head|global\s+head|vp\b|本部長|事業部長|部長|統括)\b', re.IGNORECASE)
    TIER2 = re.compile(r'\b(manager|team\s+lead|lead|supervisor|principal|senior\s+manager|group\s+manager|assistant\s+director|associate\s+director|課長|マネージャー|リーダー|主任)\b', re.IGNORECASE)
    if not title: return 1
    if TIER4.search(title): return 4
    if TIER3.search(title): return 3
    if TIER2.search(title): return 2
    return 1

def is_founder_ceo(title):
    if not title: return False
    t = title.lower()
    jp_keywords = ['創業者', '共同創業者', '代表取締役', '社長']
    if any(k in t for k in jp_keywords): return True
    en_fr_pattern = r'\b(founder|co-founder|cofounder|ceo|chief executive officer|fondateur|co-fondateur|cofondateur|pdg|président-directeur général|president directeur general)\b'
    return bool(re.search(en_fr_pattern, t))

def parse_experience(exp_text, scraped_at):
    if not exp_text: return []
    lines = [l.strip() for l in exp_text.strip().split('\n') if l.strip()]
    if not lines: return []

    raw_roles = []
    current_company = None
    i = 0
    
    while i < len(lines):
        line = lines[i]
        
        if re.search(r'^\d+\s*yrs?', line) or re.search(r'^\d+\s*mos?', line):
            i += 1; continue
        if "No email" in line or "No phone" in line or line.startswith("+"):
            i += 1; continue
            
        if line.startswith('↳'):
            title = line.replace('↳', '').strip()
            i += 1
            duration_line = lines[i] if i < len(lines) and '→' in lines[i] else ""
            if duration_line: i += 1
            
            desc_lines = []
            while i < len(lines) and not lines[i].startswith('↳') and not _looks_like_company_name(lines[i]):
                desc_lines.append(lines[i])
                i += 1
                
            is_current = 'Now' in duration_line or 'Present' in duration_line
            duration_months = 0.0
            dur_match = re.search(r'\((.*?)\)', duration_line)
            if dur_match: duration_months = parse_duration(dur_match.group(1))
            
            end_approx = None
            start_approx = None
            if scraped_at and duration_months > 0:
                # Naive back-calculation from scraped_at for the MOST RECENT role if it's current.
                # Actually, accurate back-calculation requires cumulative tracking if we assume no gaps.
                # We'll just approximate start/end for simplicity or rely on duration_months.
                pass
                
            raw_roles.append({
                'company': current_company or "Unknown",
                'title': title,
                'is_current': is_current,
                'duration_months': duration_months,
                'description': "\n".join(desc_lines).strip(),
                'seniority_tier': get_tier(title),
                'is_founder_ceo': is_founder_ceo(title),
                'duration_line': duration_line
            })
            continue # We already advanced i
            
        else:
            current_company = line
            
        i += 1
        
    grouped_stays = []
    for role in raw_roles:
        company = role['company']
        if grouped_stays and _should_merge_companies(grouped_stays[-1]['company'], company):
            grouped_stays[-1]['roles'].append(role)
            grouped_stays[-1]['total_tenure_months'] += role['duration_months']
            if role['is_current']: grouped_stays[-1]['is_current_company'] = True
        else:
            grouped_stays.append({
                'company': company,
                'company_normalized': _normalize_company_name(company),
                'roles': [role],
                'total_tenure_months': role['duration_months'],
                'is_current_company': role['is_current'],
                'num_internal_roles': 0
            })
            
    for stay in grouped_stays:
        stay['num_internal_roles'] = len(stay['roles'])
        
    return grouped_stays

def _looks_like_company_name(line):
    # Heuristic: short line, no punctuation that looks like a description, maybe capitalized
    if len(line) > 50: return False
    if line.startswith('↳') or '→' in line: return False
    return True

def parse_education(edu_text):
    if not edu_text: return []
    lines = [l.strip() for l in edu_text.strip().split('\n') if l.strip()]
    if not lines: return []
    
    edus = []
    current_inst = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('↳'):
            degree_field = line.replace('↳', '').strip()
            i += 1
            duration_line = lines[i] if i < len(lines) and '→' in lines[i] else ""
            if duration_line: i += 1
            
            desc_lines = []
            while i < len(lines) and not lines[i].startswith('↳') and not _looks_like_company_name(lines[i]):
                desc_lines.append(lines[i])
                i += 1
                
            parts = [p.strip() for p in degree_field.split(',', 1)]
            degree = parts[0] if len(parts) > 0 else ""
            field = parts[1] if len(parts) > 1 else ""
            
            edus.append({
                'institution': current_inst or "Unknown",
                'degree': degree,
                'field': field,
                'duration_line': duration_line,
                'description': "\n".join(desc_lines).strip()
            })
            continue
        else:
            current_inst = line
        i += 1
    return edus

def main():
    conn = psycopg2.connect(
        dbname=os.getenv('DB_NAME','metaview_scraper'),
        user=os.getenv('DB_USER','scraper_user'),
        password=os.getenv('DB_PASSWORD','scraper_password'),
        host=os.getenv('DB_HOST','localhost'),
        port=os.getenv('DB_PORT','5433')
    )
    conn.autocommit = True
    load_company_mappings(conn)
    
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    print("Fetching profiles...")
    cursor.execute("""
        SELECT c.profile_url, c.name, c.headline, c.location, c.current_company, c.scraped_at, c.experience, c.education 
        FROM candidates_upgraded c
        WHERE NOT EXISTS (
            SELECT 1 FROM candidate_profiles_parsed p WHERE p.profile_url = c.profile_url
        )
    """)
    rows = cursor.fetchall()
    
    insert_sql = """
        INSERT INTO candidate_profiles_parsed 
        (profile_url, name, headline, location, current_company, scraped_at, experience_json, education_json)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (profile_url) DO UPDATE SET
            name = EXCLUDED.name,
            headline = EXCLUDED.headline,
            location = EXCLUDED.location,
            current_company = EXCLUDED.current_company,
            scraped_at = EXCLUDED.scraped_at,
            experience_json = EXCLUDED.experience_json,
            education_json = EXCLUDED.education_json,
            parsed_at = NOW()
    """
    
    print("Parsing and inserting...")
    batch = []
    batch_size = 500
    insert_cursor = conn.cursor()
    for row in tqdm(rows):
        exp_json = parse_experience(row['experience'], row['scraped_at'])
        edu_json = parse_education(row['education'])
        
        batch.append((
            row['profile_url'], row['name'], row['headline'], row['location'],
            row['current_company'], row['scraped_at'],
            json.dumps(exp_json), json.dumps(edu_json)
        ))
        
        if len(batch) >= batch_size:
            insert_cursor.executemany(insert_sql, batch)
            batch = []
            
    if batch:
        insert_cursor.executemany(insert_sql, batch)
        
    print("Done!")
    insert_cursor.close()
    cursor.close()
    conn.close()

if __name__ == "__main__":
    main()
