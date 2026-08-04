"""
jd_tree_scorer.py — Tree-based candidate scoring (no LLM required).

Usage:
    python3 jd_tree_scorer.py                     # uses embedded sample JD
    python3 jd_tree_scorer.py --jd "path/to/jd.txt"
    python3 jd_tree_scorer.py --top 50
"""
import re, sys, time, argparse, datetime, json, os
from collections import Counter
from typing import Optional
import numpy as np, pandas as pd, psycopg2
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import cross_val_score

DB_CONFIG = {"host":"localhost","port":5433,"dbname":"metaview_scraper","user":"scraper_user","password":"scraper_password"}

SAMPLE_JD = """
Business Development Manager
事業開発マネージャー
Craif Inc. | Craif株式会社
Location: Tokyo HQ
About Craif
Craif Inc. is a Bio-AI startup founded in 2018 as a spin-out from Nagoya University. Our mission is to "realize a society where people live
out their natural lifespan." We develop innovative cancer risk screening tests using cutting-edge AI and liquid biopsy technology.
Our flagship product, MySignal, is a urine-based multi-cancer risk screening test. It detects cancer risk for multiple cancer types through a
simple urine sample, removing barriers to early detection.
Craif is backed by top-tier domestic and international VCs, and we are preparing for a NASDAQ IPO. We offer a dynamic, mission-driven
work environment where your contributions directly impact global healthcare.
Role Background
Craif is expanding distribution of MySignal through corporate health management programs and OTC retail channels. We seek a Business
Development Manager to lead strategy and execution in either the corporate wellness or retail/drugstore sector.
This role requires strategic thinking combined with hands-on sales execution. You will design go-to-market strategies, build partnerships,
and drive revenue growth in your assigned vertical.
Key Responsibilities
• Design business strategy and KPIs for assigned vertical
• Standardize and optimize sales processes
• Build and manage strategic alliances
• Lead cross-functional projects
• Plan and execute field sales and customer success initiatives
• Collect and analyze customer insights
Required Qualifications
• 3+ years in new business development or large account sales with strong results
• Strategy or new business launch experience at consulting firm or company
Preferred Qualifications
• Large retail/drugstore or corporate B2B sales experience
• Health management or HR experience
• Team management experience
• Process improvement experience
• Startup experience
Employment Details
Employment Type Full-time (Permanent)
Compensation Annual salary (negotiable), transportation fully covered, raises twice per year
Working Hours 9:00-18:00 (flexible per contract)
Location 東京都新宿区新小川町8-30 THE PORTAL iidabashi B1F
Exentive G.K
Create Yoyogi 202
2-39-10 Yoyogi, Shibuyaku
Tokyo, 151-0053, Japan
T/F: +81-3-6276-6483
Benefits Special paid leave (up to 5 days on joining), Partnership leave (up to 5 days), Long-term
business trip allowance, US-style stock options, Team building programs, Mentor 1-on-1,
Training programs, OKR management
Craifについて
Craifは、2018年に創業した名古屋大学発のバイオAIスタートアップです。「人々が天寿を全うする社会の実現」を掲げ、がんをはじめ
とする病によって人生の可能性が失われることのない未来を創ろうとしています。
がんは、日本では2人に1人が罹患するといわれ、4000年もの間、人類が克服できていない最も大きな課題のひとつです。一方で、がん
検診の受診率は40%前後にとどまり、多くの人が早期発見の機会を逃しているのが現状です。
Craifは、こうした心理的・社会的なハードルをテクノロジーで乗り越え、誰もが自然に予防・早期発見へと行動できる社会の実現に向け
た根本的な課題解決に挑んでいます。
募集背景
Craifが手がけるがんリスク検査「マイシグナル・シリーズ」は、健康経営を推進する法人顧客やOTC（ドラッグストア・GMS等）チャ
ネルへの展開を進めています。
このポジションでは、法人営業または小売チャネルでの事業戦略立案から実行までをリードしていただきます。
仕事内容
• 事業戦略・KPI設計
• 営業プロセスの標準化
• アライアンスマネジメント
• プロジェクトマネジメント
• FS/CS企画
• 顧客インサイト収集
応募要件（MUST）
• 新規開拓営業または大型既存顧客深耕営業で3年以上の実績
• コンサルティングファームまたは事業会社での戦略・新規事業立ち上げ経験
歓迎要件（WANT）
• 大手小売/ドラッグストアまたは法人B2B営業経験
• 健康経営・人事経験
• チームマネジメント経験
• プロセス改善経験
• スタートアップ経験
雇用条件
雇用形態 正社員
給与 年俸制、交通費原則全額支給、昇給：年2回
勤務時間 9:00〜18:00（個別の雇用契約に応じ変更可能）
Exentive G.K
Create Yoyogi 202
2-39-10 Yoyogi, Shibuyaku
Tokyo, 151-0053, Japan
T/F: +81-3-6276-6483
勤務地 東京都新宿区新小川町8-30 THE PORTAL iidabashi B1F
福利厚生 特別有給休暇（入社後最大5日間付与）、パートナーシップ休暇（最大5日）、長期出張
手当、米国式SO制度、チームビルディング促進制度、メンターとの定期1on1、研修・
学習プログラム、OKRによる目標管理
参考資料
■メンバーインタビュー note / 代表⼩野瀨 note
■会社紹介動画（1:35) / 研究所・検査センター紹介動画（6:18）
■VC X&KSK本⽥圭佑さん×代表⼩野瀨対談（7:32）
■YouTubeチャンネル スタートアップ酒場（22:50）
"""

# ═══════════════════════════════════════════════════════════════════════════════
#  FEATURE ENGINEERING
# ═══════════════════════════════════════════════════════════════════════════════

def parse_total_years(exp): 
    if not exp: return 0.0
    fl = exp.split("\n")[0].strip().lower()
    y = 0.0
    m = re.search(r"(\d+)\s*yr", fl)
    if m: y += int(m.group(1))
    m = re.search(r"(\d+)\s*mo", fl)
    if m: y += int(m.group(1))/12
    return y

def count_roles(exp):
    return len(re.findall(r"↳", exp)) if exp else 0

def count_companies(exp):
    if not exp: return 0
    c = 0
    for line in exp.split("\n"):
        line = line.strip()
        if not line or line.startswith("↳") or line.startswith("+") or re.match(r"\d", line): continue
        if "yr" in line.lower() and "mo" in line.lower(): continue
        if line in ("No email selected","No phone selected","Summary"): continue
        c += 1
    return c

def longest_tenure_mo(exp):
    if not exp: return 0.0
    mx = 0.0
    for m in re.finditer(r"\((\d+)\s*yr[s]?\s*(?:(\d+)\s*mo[s]?)?\)", exp):
        mx = max(mx, int(m.group(1))*12 + (int(m.group(2)) if m.group(2) else 0))
    for m in re.finditer(r"\((\d+)\s*mo[s]?\)", exp):
        mx = max(mx, int(m.group(1)))
    return mx

def avg_tenure_mo(exp):
    if not exp: return 0.0
    vals = []
    for m in re.finditer(r"\((\d+)\s*yr[s]?\s*(?:(\d+)\s*mo[s]?)?\)", exp):
        vals.append(int(m.group(1))*12 + (int(m.group(2)) if m.group(2) else 0))
    for m in re.finditer(r"\((\d+)\s*mo[s]?\)", exp):
        v = int(m.group(1)); 
        if v not in vals: vals.append(v)
    return float(np.mean(vals)) if vals else 0.0

def current_tenure_mo(exp):
    if not exp: return 0.0
    m = re.search(r"\((\d+)\s*yr[s]?\s*(?:(\d+)\s*mo[s]?)?\)", exp)
    if m: return int(m.group(1))*12 + (int(m.group(2)) if m.group(2) else 0)
    m = re.search(r"\((\d+)\s*mo[s]?\)", exp)
    return int(m.group(1)) if m else 0.0

def is_employed(exp):
    return 1 if exp and re.search(r"\b(Now|Present|Current|今)\b", exp, re.I) else 0

def kw_count(text, kws):
    if not text: return 0
    t = text.lower()
    return sum(1 for k in kws if k.lower() in t)

def kw_density(text, kws):
    return kw_count(text, kws)/max(len(kws),1)

_T4 = re.compile(r"\b(chief|ceo|cto|cfo|coo|cmo|cro|president|founder|co-founder|代表取締役|執行役員|社長)\b", re.I)
_T3 = re.compile(r"\b(vice\s+president|svp|evp|managing\s+director|general\s+manager|partner|director|head\s+of|vp\b|本部長|部長)\b", re.I)
_T2 = re.compile(r"\b((?:sales\s+)?manager|team\s+lead|supervisor|principal|senior\s+manager|課長|マネージャー)\b", re.I)

def seniority_tier(title):
    if not title: return 1
    if _T4.search(title): return 4
    if _T3.search(title): return 3
    if _T2.search(title): return 2
    return 1

def has_degree(edu):
    return 1 if edu and re.search(r"(bachelor|master|mba|phd|doctor|degree|学士|修士|博士)", edu, re.I) else 0

def infer_language(row):
    score = 0
    name = str(row.get("name", ""))
    summary = str(row.get("summary", ""))
    edu = str(row.get("education", ""))
    exp = str(row.get("experience", ""))
    
    if re.search(r"[A-Za-z]{3,}", name): score += 1
    if re.search(r"\b(the|and|in|of|to|for|with|management|sales|business|team|project)\b", summary, re.I): score += 2
    if re.search(r"\b(University of|State University|College|Institute of Technology|USA|UK|Australia|Canada|London|California|New York|Sydney|Melbourne)\b", edu, re.I): score += 2
    if re.search(r"\b(New York|London|Singapore|San Francisco|Sydney|Hong Kong|Los Angeles|Chicago|Toronto|Vancouver|Berlin|Paris)\b", exp, re.I): score += 1
        
    return min(score, 3)

def loc_match(loc, targets):
    if not loc or not targets: return 0
    l = loc.lower()
    return 1 if any(t.lower() in l for t in targets) else 0

# ── Role-keyword matching using latest_role + first experience block ─────────
def current_role_kw(latest_role, exp, kws):
    """Match keywords against latest_role AND the first role block in experience."""
    parts = (latest_role or "")
    if exp:
        # grab first 3 lines of experience (company + role + dates)
        first_block = "\n".join(exp.split("\n")[:5])
        parts = parts + " " + first_block
    return kw_count(parts, kws)

# ═══════════════════════════════════════════════════════════════════════════════
#  JD PARSER
# ═══════════════════════════════════════════════════════════════════════════════

DOMAIN_KW = {
    "sales": ["sales","account executive","deal","pipeline","prospecting","lead generation",
              "enterprise","corporate","closing","negotiat","revenue","quota","territory",
              "client","b2b","saas","business development","account management","crm",
              "subsidiary","expansion","upsell","cross-sell"],
    "tech": ["software","engineer","python","typescript","react","aws","cloud","devops",
             "kubernetes","api","backend","frontend","machine learning","data","infrastructure"],
    "marketing": ["marketing","brand","campaign","digital","content","seo","analytics",
                   "social media","pr","communications","go-to-market","growth hacking"],
    "finance": ["finance","accounting","investment","banking","portfolio","risk","compliance",
                "audit","treasury","credit","cfo","controller","controllership","fp&a",
                "financial planning","financial analysis","gaap","ifrs","budgeting","forecasting",
                "cash flow","capital management","working capital","variance analysis",
                "financial reporting","financial statements","month-end","quarter-end","year-end",
                "internal controls","sox","sarbanes","cost accounting","general ledger",
                "accounts payable","accounts receivable","reconciliation","tax","statutory",
                "financial governance","asset protection","fiscal","debt structuring",
                "liquidity","covenant","excise","inventory valuation","経理","財務","会計",
                "監査","予算","決算"],
    "bizdev": ["business development","biz dev","partnerships","go-to-market","gtm",
               "commercial strategy","market entry","channel","alliances","事業開発",
               "事業戦略","新規事業"],
    "hr": ["human resources","talent acquisition","recruiting","people operations","compensation",
           "benefits","hrbp","organizational development","人事"],
    "product": ["product manager","product management","product owner","roadmap","user research",
                "product strategy","product development"],
    "operations": ["operations","supply chain","logistics","procurement","manufacturing",
                   "warehouse","distribution","サプライチェーン","物流"],
    "legal": ["legal","counsel","attorney","lawyer","litigation","intellectual property",
              "contract","regulatory affairs","法務"],
}

def parse_excluded_domains(jd_text):
    """Extract excluded domain keywords from JD EXCLUDED_DOMAINS / negative overlap sections."""
    jl = jd_text.lower()
    excluded_kws = []
    
    # Look for explicit exclude sections
    exclude_block = re.search(r"(?:excluded?_?domains?|negative.?overlap|out.?of.?scope)[\s:]*(.+?)(?:\n##|\n---|\.\.\.\s*$|$)", jl, re.S)
    if exclude_block:
        block = exclude_block.group(1)
        # Extract domain names mentioned with [Exclude]
        for m in re.finditer(r"\[?exclude\]?[:\s]*([^\n]+)", block):
            phrase = m.group(1).strip()
            # Break into constituent keywords
            for word in re.split(r"[,;:&/]", phrase):
                w = word.strip().lower()
                if len(w) > 2 and w not in ("the", "and", "for", "with"):
                    excluded_kws.append(w)
    
    # Also check for explicit exclusion keywords from known DOMAIN_KW domains
    # If the JD says "excludes business development" or "this is NOT a sales role"
    for pattern in [r"(?:exclud|not|without|no)\s+(?:a\s+)?(?:business development|biz dev|sales|marketing|commercial|operations)",
                    r"(?:ring.?fenced|strictly|purely|pure)\s+(?:finance|accounting|tech|engineering)"]:
        for m in re.finditer(pattern, jl):
            match_text = m.group(0)
            for domain, kws in DOMAIN_KW.items():
                if any(k in match_text for k in kws[:5]):
                    excluded_kws.extend(kws[:10])  # Add top keywords from that domain as penalties
    
    return list(set(excluded_kws))


def parse_jd(jd_text):
    jl = jd_text.lower()
    # domain detection
    scores = {d: sum(1 for k in kws if k in jl) for d,kws in DOMAIN_KW.items()}
    domain = max(scores, key=scores.get)
    kws = DOMAIN_KW[domain]
    # min years — handle both "18 years" and "eighteen (18) years" patterns
    min_y = 3
    m = re.search(r"(\d+)\s*(?:\+\s*)?year[s]?\s*(?:of\s+)?(?:demonstrated|proven|relevant|professional|sales|corporate|progressive|total|experience)?", jl)
    if m: min_y = int(m.group(1))
    # Also check for "minimum of X years" pattern
    m2 = re.search(r"minimum\s+(?:of\s+)?(?:.*?)(\d+)\s*(?:\(\d+\))?\s*year", jl)
    if m2: min_y = max(min_y, int(m2.group(1)))
    max_y = min_y * 3 if min_y < 10 else min_y * 2
    # seniority — for IC sales roles, "account executive" is tier 1
    jd_tier = 1
    if re.search(r"\b(director|head of|vp|vice president|cfo|cto|ceo|deputy)\b", jl): jd_tier = 3
    elif re.search(r"\bsenior\s+manager\b", jl): jd_tier = 2
    # locations
    locs = []
    if "japan" in jl or "tokyo" in jl: locs = ["japan","tokyo","日本","東京"]
    # Excluded domains
    excluded_kws = parse_excluded_domains(jd_text)
    return {"min_y":min_y,"max_y":max_y,"domain":domain,"kws":kws,"jd_tier":jd_tier,"locs":locs,"excluded_kws":excluded_kws}


# ═══════════════════════════════════════════════════════════════════════════════
#  FEATURE MATRIX
# ═══════════════════════════════════════════════════════════════════════════════

def build_features(df, jd):
    print(f"  Engineering features for {len(df)} candidates...")
    t0 = time.time()
    f = pd.DataFrame(index=df.index)
    kws = jd["kws"]
    excluded_kws = jd.get("excluded_kws", [])

    f["total_years"] = df["experience"].apply(parse_total_years)
    f["num_roles"] = df["experience"].apply(count_roles)
    f["num_companies"] = df["experience"].apply(count_companies)
    f["longest_tenure"] = df["experience"].apply(longest_tenure_mo)
    f["avg_tenure"] = df["experience"].apply(avg_tenure_mo)
    f["current_tenure"] = df["experience"].apply(current_tenure_mo)
    f["is_employed"] = df["experience"].apply(is_employed)

    f["exp_in_range"] = ((f["total_years"]>=jd["min_y"])&(f["total_years"]<=jd["max_y"])).astype(int)
    ideal = (jd["min_y"]+jd["max_y"])/2
    f["exp_gap"] = np.abs(f["total_years"]-ideal)
    f["exp_ratio"] = f["total_years"]/max(jd["min_y"],1)
    f["job_hop_ratio"] = f["num_companies"]/(f["total_years"].clip(lower=1))
    f["short_stints"] = (f["avg_tenure"]<12).astype(int)

    f["sen_tier"] = df["latest_role"].fillna("").apply(seniority_tier)
    f["sen_match"] = (f["sen_tier"]==jd["jd_tier"]).astype(int)
    f["sen_gap"] = np.abs(f["sen_tier"]-jd["jd_tier"])

    # Domain keyword matching (positive signal)
    f["role_kw"] = df.apply(lambda r: current_role_kw(r["latest_role"], r["experience"], kws), axis=1)
    f["exp_kw"] = df["experience"].fillna("").apply(lambda t: kw_count(t, kws))
    f["summary_kw"] = df["summary"].fillna("").apply(lambda t: kw_count(t, kws))
    combined = df["latest_role"].fillna("")+" "+df["experience"].fillna("")+" "+df["summary"].fillna("")
    f["total_kw_density"] = combined.apply(lambda t: kw_density(t, kws))

    # Cross-domain contamination scoring (negative signal)
    # For each OTHER domain, count how many of their keywords appear in the candidate's profile
    target_domain = jd["domain"]
    other_domains = {d: kws_list for d, kws_list in DOMAIN_KW.items() if d != target_domain}
    
    # Aggregate cross-domain keyword hits
    f["cross_domain_kw"] = combined.apply(lambda t: sum(kw_count(t, other_kws) for other_kws in other_domains.values()))
    # Ratio of target-domain vs cross-domain keywords — measures functional purity
    total_positive = f["exp_kw"] + f["summary_kw"] + f["role_kw"]
    f["domain_purity"] = total_positive / (total_positive + f["cross_domain_kw"]).clip(lower=1)
    
    # Role-title domain match: does the latest_role title contain target domain keywords?
    f["role_title_domain"] = df["latest_role"].fillna("").apply(lambda t: kw_count(t, kws[:10]))
    
    # Excluded-domain scoring: penalty features from JD's explicit exclusion list
    if excluded_kws:
        f["excluded_role_kw"] = df.apply(lambda r: current_role_kw(r["latest_role"], r["experience"], excluded_kws), axis=1)
        f["excluded_exp_kw"] = df["experience"].fillna("").apply(lambda t: kw_count(t, excluded_kws))
        f["excluded_density"] = combined.apply(lambda t: kw_density(t, excluded_kws))
    else:
        f["excluded_role_kw"] = 0
        f["excluded_exp_kw"] = 0
        f["excluded_density"] = 0.0

    f["loc_match"] = df["location"].fillna("").apply(lambda l: loc_match(l, jd["locs"]))
    f["has_degree"] = df["education"].fillna("").apply(has_degree)
    f["lang_infer"] = df.apply(infer_language, axis=1)
    f["career_coherence"] = f["exp_kw"]/(f["num_roles"].clip(lower=1))

    print(f"  → {f.shape[1]} features ({len(excluded_kws)} excluded keywords) in {time.time()-t0:.1f}s")
    return f


# ═══════════════════════════════════════════════════════════════════════════════
#  SYNTHETIC LABELS — weighted multi-signal scoring
# ═══════════════════════════════════════════════════════════════════════════════

def make_labels(f, jd):
    s = np.zeros(len(f))
    # Experience alignment (0-3)
    s += np.where(f["exp_in_range"]==1, 2.5, 0)
    s += np.where((f["total_years"]>=jd["min_y"]-1)&(f["total_years"]<=jd["max_y"]+2), 0.5, 0)
    # Seniority (0-2.5)
    s += np.where(f["sen_match"]==1, 2.0, 0)
    s += np.where(f["sen_gap"]<=1, 0.5, 0)
    # Current role domain (0-3) — THIS is the key signal, boosted weight
    s += np.where(f["role_kw"]>=3, 3.0, np.where(f["role_kw"]>=2, 2.0, np.where(f["role_kw"]>=1, 1.0, 0)))
    # Role title domain match bonus (0-1.5)
    s += np.where(f["role_title_domain"]>=2, 1.5, np.where(f["role_title_domain"]>=1, 0.75, 0))
    # Overall domain density (0-2)
    p70 = f["total_kw_density"].quantile(0.7)
    s += np.where(f["total_kw_density"]>=p70, 1.5, 0)
    s += np.where(f["exp_kw"]>=5, 0.5, 0)
    # Domain purity bonus (0-1.5) — reward candidates whose profile is dominated by target domain
    s += np.where(f["domain_purity"]>=0.7, 1.5, np.where(f["domain_purity"]>=0.5, 0.75, 0))
    # Location (0-1)
    if jd["locs"]: s += np.where(f["loc_match"]==1, 1.0, 0)
    # Language Inference (0-1.5)
    s += f["lang_infer"] * 0.5
    # ── Penalties ──
    s -= np.where(f["short_stints"]==1, 1.0, 0)
    s -= np.where(f["sen_gap"]>=2, 2.0, 0)
    s -= np.where(f["total_years"]>jd["max_y"]*2, 1.5, 0)
    s -= np.where(f["total_years"]<1, 1.0, 0)
    # Cross-domain contamination penalty (0 to -3) — penalize candidates in wrong functions
    s -= np.where(f["cross_domain_kw"]>=10, 2.0, np.where(f["cross_domain_kw"]>=5, 1.0, 0))
    # Excluded-domain penalty (0 to -4) — strongest penalty, directly from JD exclusions
    s -= np.where(f["excluded_role_kw"]>=2, 3.0, np.where(f["excluded_role_kw"]>=1, 1.5, 0))
    s -= np.where(f["excluded_density"]>=0.3, 1.0, 0)

    thresh = np.percentile(s, 88)
    labels = (s>=thresh).astype(int)
    print(f"  Labels: {labels.sum()} PASS ({labels.sum()/len(labels)*100:.1f}%) | {len(labels)-labels.sum()} FAIL")
    return labels, s


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def run(jd_text, top_k=30):
    print("[1/5] Loading candidates...")
    conn = psycopg2.connect(**DB_CONFIG)
    df = pd.read_sql_query(
        "SELECT name,profile_url,headline,location,current_company,summary,experience,education,latest_role "
        "FROM candidates_data_science_use", conn)
    conn.close()
    print(f"  → {len(df)} candidates")

    print("\n[2/5] Parsing JD...")
    jd = parse_jd(jd_text)
    print(f"  → Domain={jd['domain']} | Exp={jd['min_y']}-{jd['max_y']}y | Tier={jd['jd_tier']}(1=IC) | Loc={jd['locs']}")

    print("\n[3/5] Features...")
    feats = build_features(df, jd)

    print("\n[4/5] Train tree...")
    labels, raw_scores = make_labels(feats, jd)
    X = feats.replace([np.inf,-np.inf], np.nan).fillna(0).values

    model = GradientBoostingClassifier(
        n_estimators=200, max_depth=5, learning_rate=0.1,
        min_samples_leaf=20, subsample=0.8, random_state=42)
    model.fit(X, labels)
    cv = cross_val_score(model, X, labels, cv=5, scoring="f1")
    print(f"  → CV F1: {cv.mean():.3f}±{cv.std():.3f}")

    print("\n[5/5] Scoring...")
    probas = model.predict_proba(X)[:,1]
    df["tree_score"] = probas
    for c in ["total_years","sen_tier","sen_match","exp_in_range","total_kw_density","role_kw","loc_match","career_coherence","lang_infer"]:
        df[c] = feats[c].values
    df["raw_rule_score"] = raw_scores

    # Feature importance
    print(f"\n{'='*70}\nFEATURE IMPORTANCE\n{'='*70}")
    imp = pd.Series(model.feature_importances_, index=feats.columns).sort_values(ascending=False)
    for feat, v in imp.head(12).items():
        print(f"  {feat:<28s} {v:.4f}  {'█'*int(v*80)}")

    # Results
    ranked = df.sort_values("tree_score", ascending=False).head(top_k)
    tiers = {1:"IC",2:"Mgr",3:"Dir/VP",4:"C-Suite"}
    print(f"\n{'='*70}\nTOP {top_k} CANDIDATES\n{'='*70}")
    for i, (_,r) in enumerate(ranked.iterrows(),1):
        nm = (r["name"] or "?")[:22]
        rl = (r["latest_role"] or "?")[:42]
        co = (r["current_company"] or "?")[:22]
        yr = r["total_years"]
        ti = tiers.get(int(r["sen_tier"]),"?")
        ef = "✅" if r["exp_in_range"] else "❌"
        sf = "✅" if r["sen_match"] else "❌"
        lf = "📍" if r["loc_match"] else "  "
        rk = int(r["role_kw"])
        print(f"  {i:>3}. [{r['tree_score']:.3f}] {nm:<22s} | {rl:<42s} | {co:<22s} | {yr:>4.1f}y {ef} | {ti:<6s} {sf} | rkw={rk} {lf}")

    out = "tree_scorer_results.csv"
    ranked[["name","profile_url","latest_role","current_company","location","tree_score","total_years",
            "sen_tier","sen_match","exp_in_range","total_kw_density","role_kw","loc_match","career_coherence","raw_rule_score","lang_infer"]].to_csv(out, index=False)
    print(f"\n  → Saved to {out}")
    return ranked, model, imp


def run_json():
    # 1. Read JSON payload from stdin
    input_data = sys.stdin.read()
    if not input_data:
        return json.dumps({"error": "No input provided"})
    try:
        payload = json.loads(input_data)
    except Exception as e:
        return json.dumps({"error": f"Invalid JSON: {str(e)}"})

    jd_text = payload.get("jd", "")
    company_name = payload.get("companyName", "").lower()
    candidates_raw = payload.get("candidates", [])
    top_k = payload.get("topK", 1000)
    
    # 2. Fit model on historical data (or load pre-trained if we wanted, but fitting is fast)
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        df_hist = pd.read_sql_query(
            "SELECT name,profile_url,headline,location,current_company,summary,experience,education,latest_role "
            "FROM candidates_data_science_use LIMIT 15000", conn)
        conn.close()
    except Exception as e:
        return json.dumps({"error": f"Failed DB connect: {str(e)}"})

    if not candidates_raw:
        df_ui = df_hist.copy()
    else:
        df_ui = pd.DataFrame(candidates_raw)
        # Map common ui candidate fields if necessary
        if "full_name" in df_ui.columns and "name" not in df_ui.columns: df_ui["name"] = df_ui["full_name"]
        if "ai_latest_role" in df_ui.columns and "latest_role" not in df_ui.columns: df_ui["latest_role"] = df_ui["ai_latest_role"]
        if "ai_latest_company" in df_ui.columns and "current_company" not in df_ui.columns: df_ui["current_company"] = df_ui["ai_latest_company"]
        if "ai_latest_location" in df_ui.columns and "location" not in df_ui.columns: df_ui["location"] = df_ui["ai_latest_location"]

    jd = parse_jd(jd_text)
    
    # Feature eng for historical
    feats_hist = build_features(df_hist, jd)
    labels_hist, _ = make_labels(feats_hist, jd)
    X_hist = feats_hist.replace([np.inf,-np.inf], np.nan).fillna(0).values

    model = GradientBoostingClassifier(
        n_estimators=100, max_depth=4, learning_rate=0.1,
        min_samples_leaf=10, random_state=42)
    model.fit(X_hist, labels_hist)
    
    # 3. Predict on UI candidates
    feats_ui = build_features(df_ui, jd)
    X_ui = feats_ui.replace([np.inf,-np.inf], np.nan).fillna(0).values
    probas = model.predict_proba(X_ui)[:,1]
    
    results = []
    
    # Same company generic suffix remover
    suffixes = re.compile(r"\b(inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|株式会社|k\.k\.?|s\.a\.?|b\.v\.?|plc\.?|pty\.?|group|holdings|japan|international|global)\b", re.I)
    canonical_company = suffixes.sub("", company_name).strip()
    
    for i, row in df_ui.iterrows():
        score = float(probas[i])
        
        # Same company filter
        cc = str(row.get("current_company", "")).lower()
        cc_clean = suffixes.sub("", cc).strip()
        
        if len(canonical_company) >= 3 and len(cc_clean) >= 3:
            if canonical_company in cc_clean or cc_clean in canonical_company:
                score = 0.0 # Exclude them
                
        results.append({
            "name": row.get("name", ""),
            "profile_url": row.get("profile_url", ""),
            "tree_score": score,
            "lang_infer_score": int(feats_ui["lang_infer"].iloc[i]),
            "current_company": cc
        })
        
    # Sort and return candidates (up to top K)
    results = sorted(results, key=lambda x: x["tree_score"], reverse=True)[:top_k]
        
    return json.dumps({"status": "success", "candidates": results})


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--jd", type=str)
    p.add_argument("--top", type=int, default=30)
    p.add_argument("--json", action="store_true", help="Read JSON from stdin and output JSON")
    a = p.parse_args()
    
    if a.json:
        # Save original stdout
        old_stdout = sys.stdout
        sys.stdout = open(os.devnull, 'w')
        
        try:
            # run_json needs to return the json string instead of printing
            result_json = run_json()
        except Exception as e:
            result_json = json.dumps({"error": str(e)})
            
        # Restore stdout
        sys.stdout = old_stdout
        print(result_json)
    else:
        jd = SAMPLE_JD
        if a.jd:
            with open(a.jd) as f: jd = f.read()
        t0 = time.time()
        run(jd, a.top)
        print(f"\n⏱  Total: {time.time()-t0:.1f}s")
