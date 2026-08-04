import os
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"

import re
import pandas as pd
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
import lightgbm as lgb
from lifelines import CoxPHFitter
from lifelines.utils import concordance_index
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score
from dotenv import load_dotenv
import joblib
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from torch.nn.utils.rnn import pad_sequence

# Load environment variables
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
load_dotenv(dotenv_path=env_path)

def has_advanced_degree(education_text):
    if not isinstance(education_text, str):
        return 0
    text = education_text.lower()
    if re.search(r'\b(phd|ph\.d|doctor|master|m\.s\.|m\.a\.|mba)\b', text):
        return 1
    return 0

def summary_length(summary_text):
    if not isinstance(summary_text, str):
        return 0
    return len(summary_text.split())

def extract_latest_job_description_length(exp_text):
    if not isinstance(exp_text, str):
        return 0
    return len(exp_text.split())

def is_founder_ceo(role_text):
    if not isinstance(role_text, str):
        return 0
    text = role_text.lower()
    jp_keywords = ['創業者', '共同創業者', '代表取締役', '社長']
    if any(k in text for k in jp_keywords):
        return 1
    en_fr_pattern = r'\b(founder|co-founder|cofounder|ceo|chief executive officer|fondateur|co-fondateur|cofondateur|pdg|président-directeur général|president directeur general)\b'
    if re.search(en_fr_pattern, text):
        return 1
    return 0

def parse_experience(exp_text):
    if not exp_text or not isinstance(exp_text, str):
        return {
            'total_years_experience': 0.0,
            'current_tenure_months': 0.0,
            'num_previous_companies': 0,
            'current_company': 'Unknown',
            'promotion_velocity_months': 0.0
        }
    
    lines = exp_text.strip().split('\n')
    first_line = lines[0].strip()
    
    # 1. Total Years Experience (from the first line, e.g., "12 yrs 5 mos")
    total_years = 0.0
    yr_match = re.search(r'(\d+)\s*yr', first_line)
    if yr_match:
        total_years += float(yr_match.group(1))
    
    mo_match = re.search(r'(\d+)\s*mo', first_line)
    if mo_match:
        total_years += float(mo_match.group(1)) / 12.0
        
    # 2. Current Tenure Months (look for the job marked "Now")
    current_tenure_months = 0.0
    now_match = re.search(r'Now\s*\((.*?)\)', exp_text, re.IGNORECASE)
    if now_match:
        duration_str = now_match.group(1)
        yr_m = re.search(r'(\d+)\s*yr', duration_str)
        if yr_m:
            current_tenure_months += float(yr_m.group(1)) * 12.0
        mo_m = re.search(r'(\d+)\s*mo', duration_str)
        if mo_m:
            current_tenure_months += float(mo_m.group(1))
    else:
        # If no "Now", it means their last job ended. We could count the most recent job's duration.
        # But we'll default to 0 for current tenure if they aren't currently employed.
        pass

    # 3. Number of Previous Companies (approximated by counting date range arrows '→')
    num_previous_companies = max(1, len(re.findall(r'→', exp_text)))
    
    # 4. Current Company (second line typically if first is years)
    current_company = 'Unknown'
    if len(lines) > 1:
        current_company = lines[1].strip()

    # 5. Promotion Velocity (Internal roles)
    num_roles = len(re.findall(r'↳', exp_text))
    promotions = num_roles - num_previous_companies
    promotion_velocity_months = (total_years * 12.0) / max(1, num_roles) if promotions > 0 else (total_years * 12.0) / num_previous_companies
    
    # 6. Median Tenure (Company Level)
    # We only want durations that are NOT internal role changes (not preceded by ↳)
    duration_months = []
    lines_with_durations = exp_text.split('\n')
    for line in lines_with_durations:
        if '↳' in line:
            continue # Skip internal role durations
            
        dur_match = re.search(r'\((.*?)\)', line)
        if dur_match:
            d_str = dur_match.group(1)
            m_total = 0.0
            yr_m = re.search(r'(\d+)\s*yr', d_str)
            if yr_m: m_total += float(yr_m.group(1)) * 12.0
            mo_m = re.search(r'(\d+)\s*mo', d_str)
            if mo_m: m_total += float(mo_m.group(1))
            if m_total > 0:
                duration_months.append(m_total)
    
    median_tenure_months = np.median(duration_months) if duration_months else 0.0

    return {
        'total_years_experience': total_years,
        'current_tenure_months': current_tenure_months,
        'num_previous_companies': num_previous_companies,
        'current_company': current_company,
        'promotion_velocity_months': promotion_velocity_months,
        'median_tenure_months': median_tenure_months
    }

# Global cache for DB company maps (bidirectional)
# Maps normalized company names (lowercase) → canonical English name (lowercase)
DB_EN_TO_CANONICAL = {}  # english name variants → canonical english name
DB_JA_TO_CANONICAL = {}  # japanese name variants → canonical english name

def _strip_legal_suffixes(name):
    """Strip common JP/EN legal entity suffixes and prefixes from a company name."""
    if not name:
        return ""
    normalized = name.strip()
    suffixes_to_strip = [
        '（株）', '(株)', '株式会社', '合同会社', '有限会社',
        'Co., Ltd.', 'Co.,Ltd.', 'Inc.', 'Corp.', 'Corporation',
        'K.K.', 'G.K.', 'Ltd.', 'Limited',
    ]
    prefixes_to_strip = ['株式会社', '日本']
    
    for suffix in suffixes_to_strip:
        if normalized.endswith(suffix):
            normalized = normalized[:-len(suffix)].strip()
    for prefix in prefixes_to_strip:
        if normalized.startswith(prefix) and len(normalized) > len(prefix):
            normalized = normalized[len(prefix):].strip()
    return normalized

def _normalize_company_name(name):
    """
    Normalize company names for grouping purposes.
    Handles JP/EN variants of the same company (e.g., マイクロソフト = Microsoft).
    Uses bidirectional DB maps: EN→canonical and JA→canonical.
    Returns a lowercase canonical key for comparison.
    """
    if not name:
        return ""
    
    normalized = _strip_legal_suffixes(name)
            
    # Check bidirectional DB maps (original and stripped forms)
    name_lower = name.lower().strip()
    norm_lower = normalized.lower().strip()
    
    # Check English map first
    for key in [name_lower, norm_lower]:
        if key in DB_EN_TO_CANONICAL:
            return DB_EN_TO_CANONICAL[key]
    
    # Check Japanese map
    for key in [name_lower, norm_lower]:
        if key in DB_JA_TO_CANONICAL:
            return DB_JA_TO_CANONICAL[key]
    
    # JP → EN translation map for major companies as fallback
    jp_en_map = {
        'マイクロソフト': 'microsoft',
        'アマゾン': 'amazon',
        'グーグル': 'google',
        'セールスフォース': 'salesforce',
        'オラクル': 'oracle',
        'アップル': 'apple',
        '楽天': 'rakuten',
        'ソニー': 'sony',
        'パナソニック': 'panasonic',
        'トヨタ': 'toyota',
        'ホンダ': 'honda',
        '日立': 'hitachi',
        '富士通': 'fujitsu',
        'サイボウズ': 'cybozu',
        'メルカリ': 'mercari',
        'リクルート': 'recruit',
        'ソフトバンク': 'softbank',
        'ファーストリテイリング': 'fast retailing',
        'ユニクロ': 'uniqlo',
        'デロイト': 'deloitte',
        'アクセンチュア': 'accenture',
        'ベイン': 'bain',
        'マッキンゼー': 'mckinsey',
        'ボストンコンサルティング': 'bcg',
        'PwC': 'pwc',
        'KPMG': 'kpmg',
        'エヌビディア': 'nvidia',
        'メタ': 'meta',
        'ネットフリックス': 'netflix',
        'シスコ': 'cisco',
        'SAP': 'sap',
        'IBM': 'ibm',
        'インテル': 'intel',
        'デル': 'dell',
        'HP': 'hp',
        'NEC': 'nec',
        'NTT': 'ntt',
        'KDDI': 'kddi',
        'LINE': 'line',
        'ヤフー': 'yahoo',
        'PayPay': 'paypay',
        'Zホールディングス': 'z holdings',
    }
    
    # Check JP map first (before lowering, since JP chars are case-insensitive)
    for jp_name, en_name in jp_en_map.items():
        if jp_name in normalized or jp_name in name:
            return en_name
    
    return normalized.lower().strip()


def _should_merge_companies(name_a, name_b):
    """
    Determine if two consecutive company entries should be merged.
    Returns True if they appear to be the same company.
    """
    if not name_a or not name_b:
        return False
    
    norm_a = _normalize_company_name(name_a)
    norm_b = _normalize_company_name(name_b)
    
    # Exact match after normalization
    if norm_a == norm_b:
        return True
    
    # Substring containment (handles "Microsoft" vs "Microsoft Japan" etc.)
    if len(norm_a) >= 3 and len(norm_b) >= 3:
        if norm_a in norm_b or norm_b in norm_a:
            return True
    
    return False


def extract_years_since_graduation(edu_json_str):
    import json
    if not edu_json_str:
        return 0.0
    try:
        if isinstance(edu_json_str, str):
            edu_data = json.loads(edu_json_str)
        else:
            edu_data = edu_json_str
            
        latest_year = 0
        for edu in edu_data:
            dates = edu.get('dates', '')
            import re as regex
            years = regex.findall(r'\b(19\d{2}|20\d{2})\b', dates)
            if years:
                latest = max([int(y) for y in years])
                if latest > latest_year and latest <= 2026:
                    latest_year = latest
        
        if latest_year > 0:
            return float(2026 - latest_year)
    except:
        pass
    return 0.0


# Sequential Helpers for AttritionLSTM
def build_sequences(df):
    import numpy as np
    """
    Groups stays by profile_url, sorts them chronologically (oldest first),
    and builds sequence features, durations, and events.
    """
    grouped = df.groupby('profile_url')
    X_seq_list = []
    durations_list = []
    events_list = []
    urls_list = []
    
    for url, group in grouped:
        group_chronological = group.iloc[::-1]
        seq_len = len(group_chronological)
        if seq_len == 0:
            continue
            
        durations = group_chronological['duration_months'].values
        events = group_chronological['left_job'].values
        
        # Original core features
        prior_exp_vals = group_chronological['total_years_experience'].values
        avg_hist_tenure = group_chronological['average_historical_tenure_months'].values
        median_tenure = group_chronological['median_tenure_months'].values
        
        # The 6 fixed features
        is_tier_1 = group_chronological['is_tier_1'].values
        is_boomerang = group_chronological['is_boomerang'].values
        advanced_degree = group_chronological['advanced_degree'].values
        is_founder_ceo = group_chronological['is_founder_ceo'].values
        company_flight_risk = group_chronological['company_flight_risk'].values
        career_velocity = group_chronological['career_velocity'].values
        
        # Computed features
        had_internal_promotion = group_chronological['had_internal_promotion'].values
        internal_move_rate = group_chronological['internal_move_rate'].values
        log_summary_length = group_chronological['log_summary_length'].values
        log_stay_desc_len = group_chronological['log_stay_desc_len'].values
        seniority_stagnation = group_chronological['seniority_stagnation_months'].values
        record_tenure_ratio = group_chronological['record_tenure_ratio'].values
        hist_loyalty_index = group_chronological['historical_loyalty_index'].values
        
        # 10 New high-signal DB features
        tenure_ratio = group_chronological['tenure_ratio'].values
        seniority_delta = group_chronological['seniority_delta'].values
        prior_tenure_std = group_chronological['prior_tenure_std'].values
        prior_max_tenure = group_chronological['prior_max_tenure'].values
        max_seniority_tier = group_chronological['max_seniority_tier'].values
        num_internal_roles = group_chronological['num_internal_roles'].values
        tenure_range_ratio = group_chronological['tenure_range_ratio'].values
        seniority_velocity = group_chronological['seniority_velocity'].values
        num_skills = group_chronological['num_skills'].values
        skill_breadth = group_chronological['skill_breadth'].values
        
        prev_durations = np.zeros(seq_len)
        if seq_len > 1:
            prev_durations[1:] = durations[:-1]
            
        import numpy as np
        X_step = np.column_stack([
            prior_exp_vals,
            avg_hist_tenure,
            median_tenure,
            is_tier_1,
            is_boomerang,
            had_internal_promotion,
            internal_move_rate,
            advanced_degree,
            log_summary_length,
            log_stay_desc_len,
            is_founder_ceo,
            company_flight_risk,
            seniority_stagnation,
            career_velocity,
            record_tenure_ratio,
            hist_loyalty_index,
            tenure_ratio,
            seniority_delta,
            prior_tenure_std,
            prior_max_tenure,
            max_seniority_tier,
            num_internal_roles,
            tenure_range_ratio,
            seniority_velocity,
            num_skills,
            skill_breadth
        ]).astype(np.float32)
        
        X_seq_list.append(X_step)
        durations_list.append(durations.astype(np.float32))
        events_list.append(events.astype(np.float32))
        urls_list.append(url)
        
    return X_seq_list, durations_list, events_list, urls_list


class CareerSequenceDataset(Dataset):
    def __init__(self, X_seq, durations, events):
        self.X_seq = X_seq
        self.durations = durations
        self.events = events
        
    def __len__(self):
        return len(self.X_seq)
        
    def __getitem__(self, idx):
        return (
            torch.tensor(self.X_seq[idx], dtype=torch.float32),
            torch.tensor(self.durations[idx], dtype=torch.float32),
            torch.tensor(self.events[idx], dtype=torch.float32)
        )


def collate_fn(batch):
    batch = sorted(batch, key=lambda x: len(x[0]), reverse=True)
    sequences, durations, events = zip(*batch)
    lengths = torch.tensor([len(s) for s in sequences], dtype=torch.long)
    padded_seqs = pad_sequence(sequences, batch_first=True, padding_value=0.0)
    padded_durations = pad_sequence(durations, batch_first=True, padding_value=0.0)
    padded_events = pad_sequence(events, batch_first=True, padding_value=0.0)
    return padded_seqs, padded_durations, padded_events, lengths


class AttritionLSTM(nn.Module):
    def __init__(self, input_dim=20, hidden_dim=32, num_layers=1):
        super(AttritionLSTM, self).__init__()
        self.lstm = nn.LSTM(input_dim, hidden_dim, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_dim, 1)
        
    def forward(self, x, lengths):
        packed_x = nn.utils.rnn.pack_padded_sequence(x, lengths.cpu(), batch_first=True, enforce_sorted=True)
        packed_out, _ = self.lstm(packed_x)
        out, _ = nn.utils.rnn.pad_packed_sequence(packed_out, batch_first=True)
        log_hazard = self.fc(out).squeeze(-1)
        return log_hazard


def cox_loss(log_hazards, durations, events):
    sorted_durations, idx = torch.sort(durations, descending=True)
    sorted_log_hazards = log_hazards[idx]
    sorted_events = events[idx]
    
    exp_h = torch.exp(sorted_log_hazards)
    cumsum_exp_h = torch.cumsum(exp_h, dim=0)
    
    epsilon = 1e-8
    log_risk_sums = torch.log(cumsum_exp_h + epsilon)
    loss = -torch.sum(sorted_events * (sorted_log_hazards - log_risk_sums))
    
    num_events = torch.sum(sorted_events)
    if num_events > 0:
        loss = loss / num_events
    else:
        loss = loss * 0.0
    return loss


def compute_breslow_survival(train_log_hazards, train_durations, train_events):
    if torch.is_tensor(train_log_hazards):
        train_log_hazards = train_log_hazards.detach().cpu().numpy()
    if torch.is_tensor(train_durations):
        train_durations = train_durations.detach().cpu().numpy()
    if torch.is_tensor(train_events):
        train_events = train_events.detach().cpu().numpy()
        
    unique_times = np.unique(train_durations)
    unique_times = np.sort(unique_times)
    
    baseline_hazards = []
    exp_h = np.exp(train_log_hazards)
    
    for t in unique_times:
        events_at_t = np.sum(train_events[train_durations == t])
        risk_set_mask = (train_durations >= t)
        risk_sum = np.sum(exp_h[risk_set_mask])
        
        if risk_sum > 0:
            hazard_at_t = events_at_t / risk_sum
        else:
            hazard_at_t = 0.0
        baseline_hazards.append(hazard_at_t)
        
    baseline_hazards = np.array(baseline_hazards)
    cumulative_hazard = np.cumsum(baseline_hazards)
    baseline_survival = np.exp(-cumulative_hazard)
    return unique_times, baseline_survival


def evaluate_lstm(model, dataloader, device):
    model.eval()
    all_preds = []
    all_durations = []
    all_events = []
    
    with torch.no_grad():
        for seqs, durations, events, lengths in dataloader:
            seqs, lengths = seqs.to(device), lengths.to(device)
            log_hazards = model(seqs, lengths)
            
            max_len = seqs.size(1)
            mask = torch.arange(max_len, device=device).unsqueeze(0) < lengths.unsqueeze(1)
            
            valid_preds = log_hazards[mask].cpu().numpy()
            valid_durations = durations[mask].numpy()
            valid_events = events[mask].numpy()
            
            all_preds.extend(valid_preds)
            all_durations.extend(valid_durations)
            all_events.extend(valid_events)
            
    all_preds = np.array(all_preds)
    all_durations = np.array(all_durations)
    all_events = np.array(all_events)
    
    c_idx = concordance_index(all_durations, -all_preds, all_events)
    return c_idx, all_preds, all_durations, all_events


def load_and_preprocess_data():
    import psycopg2
    import os
    import pandas as pd
    import numpy as np
    
    print("--- 1. Connecting to PostgreSQL and Loading Data ---")
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        port=os.getenv("DB_PORT", "5433")
    )
    
    query = """
    SELECT 
        cce.*,
        v1.summary,
        v2.education_json,
        v2.experience_json,
        COALESCE(jsonb_array_length(ces.technical_skills), 0) as num_tech_skills,
        (
            (CASE WHEN jsonb_array_length(ces.technical_skills) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.domain_expertise) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.tools_platforms) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.soft_skills) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.languages) > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN jsonb_array_length(ces.certifications) > 0 THEN 1 ELSE 0 END)
        ) as skill_breadth
    FROM candidate_career_events cce
    JOIN candidates_data_science_use v1 ON cce.profile_url = v1.profile_url
    JOIN candidates_data_science_use_v2 v2 ON cce.profile_url = v2.profile_url
    LEFT JOIN candidate_extracted_skills ces ON cce.profile_url = ces.profile_url
    WHERE cce.duration_months > 0
    LIMIT 25000
    """
    print("Loading data in chunks to save memory...")
    chunks = pd.read_sql(query, conn, chunksize=5000)
    df = pd.concat(chunks, ignore_index=True)
    conn.close()
    
    print(f"Loaded {len(df)} stays from database.")
    
    df['total_years_experience'] = df['prior_total_exp_months'] / 12.0
    df['average_historical_tenure_months'] = df['prior_avg_tenure_months']
    df['median_tenure_months'] = df['prior_median_tenure_months']
    
    # Fix is_tier_1
    tier1_names = ['google','amazon','microsoft','apple','mckinsey','bcg','bain','goldman','netflix','meta','deloitte','accenture','jpmorgan']
    df['is_tier_1'] = df['company_normalized'].str.lower().apply(lambda x: 1 if any(t in str(x) for t in tier1_names) else 0)
    
    # Fix is_boomerang (any duplicated company_normalized per profile)
    # MOVED to after sorting chronologically
    
    df['had_internal_promotion'] = (df['num_internal_roles'].fillna(1) > 1).astype(int)
    df['total_career_months'] = df['prior_total_exp_months'].fillna(0) + df['duration_months'].fillna(0)
    df['internal_move_rate'] = np.where(df['total_career_months'] > 0, df['num_internal_roles'].fillna(1) / (df['total_career_months'] / 12.0), 0.0)
    
    # Fix advanced_degree
    df['advanced_degree'] = df['education_json'].apply(lambda x: has_advanced_degree(str(x)) if x else 0)
    
    df['log_summary_length'] = np.log1p(df['summary'].str.len().fillna(0))
    
    import json
    def compute_stay_desc_len(row):
        exp = row.get('experience_json')
        if not exp: return 0
        if isinstance(exp, str):
            try: exp = json.loads(exp)
            except: return 0
        if not isinstance(exp, list): return 0
        desc_len = 0
        for e in exp:
            if isinstance(e, dict) and e.get('roles'):
                for r in e['roles']:
                    if r.get('company') == row.get('company') and r.get('description'):
                        desc_len += len(str(r['description']).split())
        return desc_len

    print("--- Parsing Stay Descriptions ---")
    df['log_stay_desc_len'] = np.log1p(df.apply(compute_stay_desc_len, axis=1))
    
    df['is_founder_ceo'] = df['is_founder_ceo'].fillna(0).astype(int)
    
    # Fix company_flight_risk (empirical churn)
    company_churn = df.groupby('company_normalized')['left_job'].mean()
    df['company_flight_risk'] = df['company_normalized'].map(company_churn).fillna(company_churn.mean())
    
    df['seniority_stagnation_months'] = df['seniority_stagnation_months'].fillna(0.0)
    
    # Fix career_velocity (use historical velocity instead of single-stay delta)
    df['career_velocity'] = df['max_seniority_tier'].fillna(1.0) / (df['prior_total_exp_months'].clip(1) / 12.0)
    
    # New features from DB
    df['tenure_ratio'] = df['tenure_ratio'].fillna(0.0)
    df['seniority_delta'] = df['seniority_delta'].fillna(0.0)
    df['prior_tenure_std'] = df['prior_tenure_std_months'].fillna(0.0)
    df['prior_max_tenure'] = df['prior_max_tenure_months'].fillna(0.0)
    df['max_seniority_tier'] = df['max_seniority_tier'].fillna(1.0)
    df['num_internal_roles'] = df['num_internal_roles'].fillna(1.0)
    
    df['num_skills'] = df['num_tech_skills'].fillna(0)
    df['skill_breadth'] = df['skill_breadth'].fillna(0)
    
    # New Engineered Features
    df['tenure_range_ratio'] = np.where(df['prior_min_tenure_months'] > 0, df['prior_max_tenure_months'] / df['prior_min_tenure_months'], 1.0).clip(0, 20)
    df['seniority_velocity'] = np.where(df['prior_total_exp_months'] > 0, df['max_seniority_tier'] / (df['prior_total_exp_months'] / 12.0), 0.0)
    
    df_stays = df
    print("--- Sorting Stays Chronologically ---")
    df_stays.sort_values(by=['profile_url', 'stay_order'], ascending=[True, False], inplace=True)
    df_stays.reset_index(drop=True, inplace=True)
    
    print("--- Computing Boomerang and Sequential Features ---")
    # 0. is_boomerang (properly flagged only for the return stays)
    df_stays['is_boomerang'] = df_stays.groupby('profile_url')['company_normalized'].transform(lambda x: x.duplicated(keep='first').astype(int))
    
    # 1. Record Tenure Ratio
    df_stays['record_tenure_ratio'] = df_stays['duration_months'] / df_stays['prior_max_tenure_months'].replace(0, np.nan)
    df_stays['record_tenure_ratio'] = df_stays['record_tenure_ratio'].fillna(1.0)
    
    # 2. Historical Loyalty Index
    df_stays['historical_loyalty_index'] = df_stays['prior_max_tenure_months'] / df_stays['prior_total_exp_months'].replace(0, np.nan)
    df_stays['historical_loyalty_index'] = df_stays['historical_loyalty_index'].fillna(1.0)
    
    features_list = [
        'total_years_experience', 'average_historical_tenure_months',
        'median_tenure_months', 'is_tier_1', 'is_boomerang', 'had_internal_promotion',
        'internal_move_rate', 'advanced_degree', 'log_summary_length', 'log_stay_desc_len',
        'is_founder_ceo', 'company_flight_risk', 'seniority_stagnation_months',
        'career_velocity', 'record_tenure_ratio', 'historical_loyalty_index',
        'tenure_ratio', 'seniority_delta', 'prior_tenure_std', 'prior_max_tenure',
        'max_seniority_tier', 'num_internal_roles', 'tenure_range_ratio', 'seniority_velocity',
        'num_skills', 'skill_breadth'
    ]
    
    df_stays[features_list] = df_stays[features_list].fillna(0)
    
    print("Data loading and preprocessing complete.")
    return df_stays

def lgb_cox_objective(y_true, y_pred):
    durations = np.abs(y_true)
    events = (y_true > 0).astype(np.float32)
    sort_idx = np.argsort(durations)
    unsort_idx = np.argsort(sort_idx)
    d_sorted = durations[sort_idx]
    e_sorted = events[sort_idx]
    p_sorted = y_pred[sort_idx]
    theta = np.exp(p_sorted)
    risk_sums = np.cumsum(theta[::-1])[::-1]
    epsilon = 1e-8
    A = e_sorted / (risk_sums + epsilon)
    C = np.cumsum(A)
    grad = theta * C - e_sorted
    A2 = e_sorted / ((risk_sums + epsilon) ** 2)
    C2 = np.cumsum(A2)
    hess = theta * C - (theta ** 2) * C2
    hess = np.clip(hess, 1e-4, None)
    return grad[unsort_idx], hess[unsort_idx]


def train_models(df):
    import json
    
    # Features for flat models (CoxPH & LightGBM Survival)
    features = [
        'total_years_experience', 'average_historical_tenure_months',
        'median_tenure_months', 'is_tier_1', 'is_boomerang', 'had_internal_promotion',
        'internal_move_rate', 'advanced_degree', 'log_summary_length', 'log_stay_desc_len',
        'is_founder_ceo', 'company_flight_risk', 'seniority_stagnation_months',
        'career_velocity', 'record_tenure_ratio', 'historical_loyalty_index',
        'tenure_ratio', 'seniority_delta', 'prior_tenure_std', 'prior_max_tenure',
        'max_seniority_tier', 'num_internal_roles', 'tenure_range_ratio', 'seniority_velocity',
        'num_skills', 'skill_breadth'
    ]
    
    print("\n--- 3. Splitting Candidates Train/Test (80/20) ---")
    unique_profiles = df['profile_url'].unique()
    train_profiles, test_profiles = train_test_split(unique_profiles, test_size=0.2, random_state=42)
    
    df_train = df[df['profile_url'].isin(train_profiles)].copy()
    df_test = df[df['profile_url'].isin(test_profiles)].copy()
    
    print(f"Train profiles: {len(train_profiles)} ({len(df_train)} stays)")
    print(f"Test profiles: {len(test_profiles)} ({len(df_test)} stays)")
    
    # ---------------------------------------------
    # Filter out zero-variance features to prevent singular matrix convergence errors in CoxPH
    active_features = []
    for f in features:
        if df_train[f].std() > 1e-4:
            active_features.append(f)
        else:
            print(f"Dropping zero-variance feature: {f}")
            
    # MODEL 1: Cox Proportional Hazards (lifelines)
    # ---------------------------------------------
    print("\n--- 4. Training Cox Proportional Hazards ---")
    # Penalizer added to fix convergence (singular matrix) with new features
    cph = CoxPHFitter(penalizer=0.1)
    cph.fit(df_train[active_features + ['duration_months', 'left_job']], 
            duration_col='duration_months', 
            event_col='left_job')
    
    cph_pred_train = cph.predict_partial_hazard(df_train[active_features])
    cph_pred_test = cph.predict_partial_hazard(df_test[active_features])
    
    cph_train_cidx = concordance_index(df_train['duration_months'], -cph_pred_train, df_train['left_job'])
    cox_score = concordance_index(df_test['duration_months'], -cph_pred_test, df_test['left_job'])
    cph_test_cidx = cox_score
    
    print(f"CoxPH Train C-index: {cph_train_cidx:.4f}")
    print(f"CoxPH Test C-index: {cph_test_cidx:.4f}")
    
    # ---------------------------------------------
    # MODEL 2: LightGBM Survival Regressor
    # ---------------------------------------------
    print("\n--- 5. Training LightGBM Survival ---")
    
    y_train_lgb = np.where(df_train['left_job'] == 1, df_train['duration_months'], -df_train['duration_months'])
    y_test_lgb = np.where(df_test['left_job'] == 1, df_test['duration_months'], -df_test['duration_months'])
    
    lgb_model = lgb.LGBMRegressor(
        objective=lgb_cox_objective,
        n_estimators=300,
        learning_rate=0.03,
        num_leaves=128,
        max_depth=6,
        colsample_bytree=0.4,
        reg_alpha=0.1,
        reg_lambda=0.1,
        min_child_samples=5,
        min_sum_hessian_in_leaf=1e-5,
        random_state=42,
        n_jobs=1
    )
    lgb_model.fit(df_train[features], y_train_lgb)
    
    lgb_pred_train = lgb_model.predict(df_train[features])
    lgb_pred_test = lgb_model.predict(df_test[features])
    
    lgb_train_cidx = concordance_index(df_train['duration_months'], -lgb_pred_train, df_train['left_job'])
    lgb_test_cidx = concordance_index(df_test['duration_months'], -lgb_pred_test, df_test['left_job'])
    
    print(f"LightGBM Survival Train C-index: {lgb_train_cidx:.4f}")
    print(f"LightGBM Survival Test C-index: {lgb_test_cidx:.4f}")
    
    lgb_times, lgb_survival = compute_breslow_survival(lgb_pred_train, df_train['duration_months'].values, df_train['left_job'].values)
    
    # ---------------------------------------------
    # MODEL 3: PyTorch Attrition LSTM
    # ---------------------------------------------
    print("\n--- 6. Training Attrition LSTM ---")
    
    X_train_seq, train_durs, train_evts, _ = build_sequences(df_train)
    X_test_seq, test_durs, test_evts, _ = build_sequences(df_test)
    
    train_dataset = CareerSequenceDataset(X_train_seq, train_durs, train_evts)
    test_dataset = CareerSequenceDataset(X_test_seq, test_durs, test_evts)
    
    train_loader = DataLoader(train_dataset, batch_size=512, shuffle=True, collate_fn=collate_fn)
    test_loader = DataLoader(test_dataset, batch_size=512, shuffle=False, collate_fn=collate_fn)
    
    device = torch.device('cpu')
    print(f"Using device: {device}")
    
    lstm_model = AttritionLSTM(input_dim=26, hidden_dim=32, num_layers=1).to(device)
    optimizer = torch.optim.Adam(lstm_model.parameters(), lr=0.005)
    
    lstm_model.train()
    for epoch in range(10):
        total_loss = 0.0
        steps = 0
        for seqs, durations, events, lengths in train_loader:
            seqs, durations, events, lengths = seqs.to(device), durations.to(device), events.to(device), lengths.to(device)
            
            optimizer.zero_grad()
            log_hazards = lstm_model(seqs, lengths)
            
            max_len = seqs.size(1)
            mask = torch.arange(max_len, device=device).unsqueeze(0) < lengths.unsqueeze(1)
            
            loss = cox_loss(log_hazards[mask], durations[mask], events[mask])
            loss.backward()
            optimizer.step()
            
            total_loss += loss.item()
            steps += 1
            
        avg_loss = total_loss / steps if steps > 0 else 0
        print(f"Epoch {epoch+1}/10 - Loss: {avg_loss:.4f}")
        
    lstm_train_loader = DataLoader(train_dataset, batch_size=512, shuffle=False, collate_fn=collate_fn)
    lstm_train_cidx, lstm_pred_train, lstm_durs_train, lstm_evts_train = evaluate_lstm(lstm_model, lstm_train_loader, device)
    lstm_test_cidx, _, _, _ = evaluate_lstm(lstm_model, test_loader, device)
    
    print(f"LSTM Train C-index: {lstm_train_cidx:.4f}")
    print(f"LSTM Test C-index: {lstm_test_cidx:.4f}")
    
    lstm_times, lstm_survival = compute_breslow_survival(lstm_pred_train, lstm_durs_train, lstm_evts_train)
    
    # ---------------------------------------------
    # MODEL BENCHMARKING SUMMARY
    # ---------------------------------------------
    print("\n=============================================")
    print("        SURVIVAL MODEL BENCHMARK SUMMARY")
    print("=============================================")
    print(f"{'Model':<25} | {'Train C-index':<15} | {'Test C-index':<15}")
    print("-" * 61)
    print(f"{'Cox Proportional Hazards':<25} | {cph_train_cidx:<15.4f} | {cph_test_cidx:<15.4f}")
    print(f"{'LightGBM Survival':<25} | {lgb_train_cidx:<15.4f} | {lgb_test_cidx:<15.4f}")
    print(f"{'Attrition LSTM (Sequential)':<25} | {lstm_train_cidx:<15.4f} | {lstm_test_cidx:<15.4f}")
    print("=============================================")
    
    results_dict = {
        'coxph': cph_test_cidx,
        'lightgbm': lgb_test_cidx,
        'lstm': lstm_test_cidx
    }
    best_model_type = max(results_dict, key=results_dict.get)
    print(f"Best Performing Model based on Test C-index: {best_model_type.upper()} ({results_dict[best_model_type]:.4f})")
    
    artifacts_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'artifacts')
    os.makedirs(artifacts_dir, exist_ok=True)
    
    meta = {
        "best_model_type": best_model_type,
        "cox_c_index": cox_score,
        "lgb_c_index": lgb_test_cidx,
        "lstm_c_index": lstm_test_cidx,
        "cox_features": active_features
    }
    with open(os.path.join(artifacts_dir, 'best_model_meta.json'), 'w') as f:
        json.dump(meta, f, indent=2)
        
    joblib.dump(cph, os.path.join(artifacts_dir, 'cox_survival_model.joblib'))
    joblib.dump(lgb_model, os.path.join(artifacts_dir, 'lightgbm_survival_model.joblib'))
    np.save(os.path.join(artifacts_dir, 'lgb_breslow_times.npy'), lgb_times)
    np.save(os.path.join(artifacts_dir, 'lgb_breslow_survival.npy'), lgb_survival)
    
    torch.save(lstm_model.state_dict(), os.path.join(artifacts_dir, 'lstm_survival_model.pt'))
    np.save(os.path.join(artifacts_dir, 'lstm_breslow_times.npy'), lstm_times)
    np.save(os.path.join(artifacts_dir, 'lstm_breslow_survival.npy'), lstm_survival)
    
    print(f"All model artifacts successfully saved to {artifacts_dir}")
    
    # ---------------------------------------------
    # BOOMERANG STATISTICAL SIGNIFICANCE TEST
    # ---------------------------------------------
    print("\n=============================================")
    print("        BOOMERANG FEATURE ANALYSIS")
    print("=============================================")
    from lifelines import KaplanMeierFitter
    from lifelines.statistics import logrank_test
    
    boom_mask = df['is_boomerang'] == 1
    non_boom_mask = df['is_boomerang'] == 0
    
    n_boom = boom_mask.sum()
    n_non_boom = non_boom_mask.sum()
    print(f"Boomerang stays: {n_boom} ({n_boom / len(df) * 100:.1f}%)")
    print(f"Non-boomerang stays: {n_non_boom} ({n_non_boom / len(df) * 100:.1f}%)")
    
    if n_boom > 0:
        median_boom = df.loc[boom_mask, 'duration_months'].median()
        median_non = df.loc[non_boom_mask, 'duration_months'].median()
        mean_boom = df.loc[boom_mask, 'duration_months'].mean()
        mean_non = df.loc[non_boom_mask, 'duration_months'].mean()
        
        # Attrition rate (left_job)
        attrition_boom = df.loc[boom_mask, 'left_job'].mean()
        attrition_non = df.loc[non_boom_mask, 'left_job'].mean()
        
        print(f"\nMedian tenure - Boomerang: {median_boom:.1f} mo vs Non-boomerang: {median_non:.1f} mo")
        print(f"Mean tenure   - Boomerang: {mean_boom:.1f} mo vs Non-boomerang: {mean_non:.1f} mo")
        print(f"Attrition rate - Boomerang: {attrition_boom:.1%} vs Non-boomerang: {attrition_non:.1%}")
        
        # Log-rank test
        lr = logrank_test(
            df.loc[boom_mask, 'duration_months'],
            df.loc[non_boom_mask, 'duration_months'],
            event_observed_A=df.loc[boom_mask, 'left_job'],
            event_observed_B=df.loc[non_boom_mask, 'left_job']
        )
        print(f"\nLog-rank test statistic: {lr.test_statistic:.4f}")
        print(f"Log-rank p-value: {lr.p_value:.6f}")
        
        if lr.p_value < 0.05:
            print("→ SIGNIFICANT: Boomerang status has a statistically significant effect on retention (p < 0.05)")
        else:
            print("→ NOT SIGNIFICANT: Boomerang status does not significantly affect retention (p >= 0.05)")
        
        # Cox coefficient for boomerang
        if best_model_type == 'coxph':
            boom_coef = cph.summary.loc['is_boomerang'] if 'is_boomerang' in cph.summary.index else None
            if boom_coef is not None:
                print(f"\nCox PH coefficient for is_boomerang:")
                print(f"  coef: {boom_coef['coef']:.4f} (exp(coef) = {boom_coef['exp(coef)']:.4f})")
                print(f"  p-value: {boom_coef['p']:.6f}")
                if boom_coef['exp(coef)'] < 1:
                    print(f"  → Boomerangs have {(1 - boom_coef['exp(coef)'])*100:.1f}% LOWER hazard (stay longer)")
                else:
                    print(f"  → Boomerangs have {(boom_coef['exp(coef)'] - 1)*100:.1f}% HIGHER hazard (leave sooner)")
    else:
        print("No boomerang stays detected — cannot compute significance.")
    
    print("=============================================")


if __name__ == "__main__":
    df = load_and_preprocess_data()
    train_models(df)

def extract_historical_stays(exp_text):
    import re
    import numpy as np
    if not exp_text or not isinstance(exp_text, str):
        return []
    
    lines = [l.strip() for l in exp_text.strip().split('\n') if l.strip()]
    if not lines:
        return []
    
    raw_stays = []
    current_company = None
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        # Skip header or footer lines
        if re.search(r'^\d+\s*yrs?', line) or re.search(r'^\d+\s*mos?', line):
            i += 1
            continue
        if "No email" in line or "No phone" in line or line.startswith("+"):
            i += 1
            continue
            
        # If it starts with ↳, it's a role
        if line.startswith('↳'):
            role = line.replace('↳', '').strip()
            duration_line = ""
            if i + 1 < len(lines):
                next_line = lines[i+1]
                if '→' in next_line:
                    duration_line = next_line
                    i += 1 # Consume duration line
            
            # Parse duration
            duration = 0.0
            is_current = False
            if duration_line:
                if 'Now' in duration_line or 'Present' in duration_line:
                    is_current = True
                
                dur_match = re.search(r'\((.*?)\)', duration_line)
                if dur_match:
                    d_str = dur_match.group(1)
                    m_total = 0.0
                    yr_m = re.search(r'(\d+)\s*yr', d_str)
                    if yr_m: m_total += float(yr_m.group(1)) * 12.0
                    mo_m = re.search(r'(\d+)\s*mo', d_str)
                    if mo_m: m_total += float(mo_m.group(1))
                    duration = m_total
            
            is_founder = is_founder_ceo(role)
            company_name = current_company if current_company else "Unknown"
            raw_stays.append({
                'company': company_name,
                'duration': duration,
                'is_current': is_current,
                'is_founder': is_founder
            })
        else:
            # It's a company name
            current_company = line
            
        i += 1
        
    # Group consecutive stays at the same company, tracking internal role metadata.
    # Uses normalized company names for matching to handle JP/EN variants.
    grouped_stays = []
    for stay in raw_stays:
        if grouped_stays and _should_merge_companies(grouped_stays[-1]['company'], stay['company']):
            grouped_stays[-1]['duration'] += stay['duration']
            grouped_stays[-1]['num_internal_moves'] += 1
            # The most recent sub-role's duration (first one encountered in top-down order)
            if grouped_stays[-1]['most_recent_role_months'] == 0.0:
                grouped_stays[-1]['most_recent_role_months'] = stay['duration']
            if stay['is_current']:
                grouped_stays[-1]['is_current'] = True
            if stay.get('is_founder'):
                grouped_stays[-1]['is_founder'] = True
        else:
            grouped_stays.append({
                'company': stay['company'],
                'duration': stay['duration'],
                'is_current': stay['is_current'],
                'is_founder': stay.get('is_founder', False),
                'num_internal_moves': 1,  # At least 1 role = the initial role
                'most_recent_role_months': stay['duration']  # first encountered = most recent
            })
            
    # Reconstruct historical stats
    k = len(grouped_stays)
    stays = []
    
    for i in range(k):
        current_block = grouped_stays[i]
        duration = current_block['duration']
        if duration <= 0:
            continue
            
        older_blocks = grouped_stays[i+1:]
        prior_durations = [b['duration'] for b in older_blocks if b['duration'] > 0]
        prior_exp = sum(prior_durations)
        num_prev = len(prior_durations)
        avg_hist = prior_exp / max(1, num_prev) if num_prev > 0 else 0.0
        
        median_tenure = np.median(prior_durations) if prior_durations else 0.0
        
        tier_1_companies = ['Google', 'Meta', 'Apple', 'Amazon', 'Microsoft', 'Netflix', 'McKinsey', 'BCG', 'Bain', 'Goldman Sachs', 'JPMorgan', 'Mitsui Fudosan', 'Mitsubishi']
        is_tier_1 = 1 if any(t.lower() in current_block['company'].lower() for t in tier_1_companies) else 0
        
        # Boomerang Detection: Did they work here before in a NON-consecutive stay?
        # Uses _should_merge_companies() for proper JP/EN normalization.
        is_boomerang = 0
        for older_b in older_blocks:
            if _should_merge_companies(current_block['company'], older_b['company']):
                is_boomerang = 1
                break
        
        left_job = 0 if (current_block['is_current'] and i == 0) else 1
        
        # Internal mobility features
        num_internal_moves = current_block['num_internal_moves']
        most_recent_role_months = current_block['most_recent_role_months']
        months_since_last_internal_move = most_recent_role_months if num_internal_moves > 1 else duration
        had_internal_promotion = 1 if num_internal_moves > 1 else 0
        total_career_months = prior_exp + duration
        internal_move_rate = num_internal_moves / (total_career_months / 12.0) if total_career_months > 0 else 0.0
        
        # Advanced Sequence Features
        prior_max_tenure = max(prior_durations) if prior_durations else 0.0
        record_tenure_ratio = duration / prior_max_tenure if prior_max_tenure > 0 else 1.0
        historical_loyalty_index = prior_max_tenure / prior_exp if prior_exp > 0 else 1.0
        
        tenure_trend_slope = 0.0
        if len(prior_durations) >= 2:
            tenure_trend_slope = prior_durations[0] - prior_durations[1]
            
        is_step_back_role = 0 # Default, difficult to extract accurately without DB NLP
        
        stays.append({
            'company': current_block['company'],
            'duration_months': duration,
            'left_job': left_job,
            'total_years_experience': prior_exp / 12.0,
            'num_previous_companies': num_prev,
            'average_historical_tenure_months': max(0.1, avg_hist),
            'median_tenure_months': median_tenure,
            'is_tier_1': is_tier_1,
            'is_boomerang': is_boomerang,
            'had_internal_promotion': had_internal_promotion,
            'internal_move_rate': internal_move_rate,
            'num_internal_moves': num_internal_moves,
            'months_since_last_internal_move': months_since_last_internal_move,
            'is_founder_ceo': 1 if current_block.get('is_founder', False) else 0,
            'record_tenure_ratio': record_tenure_ratio,
            'historical_loyalty_index': historical_loyalty_index,
            'is_step_back_role': is_step_back_role,
            'tenure_trend_slope': tenure_trend_slope
        })
        
    return stays
