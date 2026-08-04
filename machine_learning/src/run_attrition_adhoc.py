import os
import re
import json
import joblib
import psycopg2
import pandas as pd
import numpy as np
import torch
from dotenv import load_dotenv

# Import experience parsing function
from pipeline import parse_experience, extract_historical_stays, AttritionLSTM
from inference import calculate_conditional_probability, calculate_conditional_probability_custom

# The raw Stage 4 audit output pasted by the user
raw_text = """
  [Stage4] ✅ PASS  (3/5): Kenichi Kato
  [Stage4] ✅ PASS  (4/5): Takashi Maruyama
  [Stage4] ✅ PASS  (3/5): Yoshiki Maehata
  [Stage4] ✅ PASS  (4/5): Ryoki Momma
  [Stage4] ✅ PASS  (4/5): Mikoto Matsuo
  [Stage4] ❌ FAIL  (2/5): Ryohei Miya — Candidate is overqualified with 13+ years of experience and recent senior leadership roles (Head of Digital Sales, Area Vice President), while the role requires 3 years of corporate sales and is likely an individual contributor position, indicating a clear seniority mismatch.
  [Stage4] ✅ PASS  (4/5): Akinori Nakamori
  [Stage4] ✅ PASS  (3/5): Kazuki Watanabe
  [Stage4] ✅ PASS  (4/5): Naoto Nishida
  [Stage4] ✅ PASS  (4/5): 寺西敦紀
  [Stage4] ✅ PASS  (4/5): Masato Hirota
  [Stage4] ✅ PASS  (4/5): Taku Kataura
  [Stage4] ✅ PASS  (4/5): Gaku Takeda
  [Stage4] ❌ FAIL  (2/5): 細川拓馬 — Candidate has less than 3 years of end-to-end corporate sales experience. Full-cycle sales roles at CrowdStrike total approximately 1.5 years, and previous roles were in business development or sales development, not end-to-end deal execution.
  [Stage4] ✅ PASS  (5/5): Ryota Shinno
  [Stage4] ✅ PASS  (3/5): Hideki Hiramatsu
  [Stage4] ❌ FAIL  (2/5): Yusuke Shimoda — Overqualified: candidate has 18+ years of experience and currently holds a VP-level position, while the role is a mid-level individual contributor sales position requiring 3 years of experience. Clear seniority mismatch.
  [Stage4] ✅ PASS  (3/5): Ryunosuke Watanabe
  [Stage4] ✅ PASS  (4/5): Makoto Kato
  [Stage4] ✅ PASS  (4/5): Tomoya O.
  [Stage4] ✅ PASS  (4/5): Takuto Maekawa
  [Stage4] ✅ PASS  (3/5): Yuzo Miyazaki
  [Stage4] ✅ PASS  (4/5): Giang Vo
  [Stage4] ❌ FAIL  (2/5): Hyonju Cho — Required Japanese language proficiency not evidenced in candidate profile. Additionally, candidate is significantly overqualified (21 years experience vs. 3 required) with a clear seniority mismatch (Country Manager/Director vs. individual contributor sales role).
  [Stage4] ⚠️  ERROR for Jens Heidelberg: Error code: 504
  [Stage4] ⚠️  ERROR for Yusuke Suwa: Error code: 504
  [Stage4] ✅ PASS  (3/5): Kodai Sai
  [Stage4] ⚠️  ERROR for Masa Yamashita: Error code: 504
  [Stage4] ✅ PASS  (4/5): Minako 美那子
  [Stage4] ✅ PASS  (4/5): Shimpei Sakamoto
  [Stage4] ✅ PASS  (4/5): Takashi Fuke
  [Stage4] ❌ FAIL  (2/5): Yo Takahashi — Candidate is overqualified with 10+ years of experience and a current Director-level role, while the position requires 3 years of corporate sales and is an individual contributor role, indicating a clear seniority mismatch.
  [Stage4] ⚠️  ERROR for Yuto F.: Error code: 429 - {'status': 429, 'title': 'Too Many Requests'}
  [Stage4] ✅ PASS  (4/5): Nao Okayama
  [Stage4] ✅ PASS  (4/5): 永田修也
  [Stage4] ✅ PASS  (4/5): Eimi Hirata
  [Stage4] ✅ PASS  (4/5): Gento Kubo
  [Stage4] ✅ PASS  (3/5): Kanamaru Kenji
  [Stage4] ✅ PASS  (4/5): Hirofumi Otsuka
  [Stage4] ✅ PASS  (3/5): Y I
  [Stage4] ✅ PASS  (4/5): Yu Matsushima
  [Stage4] ✅ PASS  (4/5): Satoshi Komatsu
  [Stage4] ❌ FAIL  (1/5): Yuta Goto — Candidate has only 1 year of corporate sales experience, falling short of the required 3 years. Language skills and education are not evidenced in the profile.
  [Stage4] ✅ PASS  (4/5): Tomohiro Masuda
  [Stage4] ✅ PASS  (4/5): Akira Kurebayashi
  [Stage4] ✅ PASS  (4/5): Yuki Ueno
  [Stage4] ✅ PASS  (4/5): Yumi Shiroyama
  [Stage4] ❌ FAIL  (2/5): Jaemin Lee — Required English proficiency not evidenced in candidate profile.
  [Stage4] ✅ PASS  (3/5): Leo Shiraishi
  [Stage4] ❌ FAIL  (4/5): Miyu U. — Multiple consecutive stints under 12 months (amptalk 4 mos, Meltwater 11 mos, Vimeo 2 mos) indicating job hopping.
  [Stage4] ✅ PASS  (4/5): Yoji Kobayakawa
  [Stage4] ✅ PASS  (4/5): 木本聡一郎
  [Stage4] ✅ PASS  (4/5): Mitsuteru Tajiri
  [Stage4] ❌ FAIL  (2/5): Hiroshi Ando — Candidate is significantly overqualified with 30 years of experience and a current director-level role, while the position is an individual contributor sales role requiring 3 years of experience. Profile lacks evidence of recent direct enterprise corporate sales and outbound lead generation.
  [Stage4] ✅ PASS  (3/5): Kazuyoshi Ishii
  [Stage4] ✅ PASS  (3/5): Kento Hayashi
  [Stage4] ✅ PASS  (4/5): Ryutaro Matsuo
  [Stage4] ✅ PASS  (4/5): Yuri Imazu
  [Stage4] ✅ PASS  (4/5): Keisuke Yano
  [Stage4] ❌ FAIL  (2/5): 高橋哲也 — Multiple consecutive stints under 12 months (NetApp 4 mos, PLAID Sales 8 mos) indicating job hopping. Required English proficiency not demonstrated in profile.
  [Stage4] ✅ PASS  (4/5): Yuki Okabe
  [Stage4] ✅ PASS  (4/5): Koki Tsutsumi
  [Stage4] ✅ PASS  (4/5): Misa Yanagi
  [Stage4] ❌ FAIL  (1/5): Yasuyuki Hamada — Candidate lacks the required 3 years of corporate sales experience with end-to-end deal execution. Profile shows experience in product marketing, strategy, and sales planning, but no direct sales roles. Additionally, the candidate's seniority (Director) is a mismatch for this individual contributor sales role.
  [Stage4] ❌ FAIL  (2/5): Akiko Hanatani — Candidate does not provide evidence of English proficiency, which is a required qualification for the role.
  [Stage4] ✅ PASS  (3/5): Lynn Kawabata
  [Stage4] ✅ PASS  (4/5): Jung LEE
  [Stage4] ❌ FAIL  (2/5): Goro Shimazaki — Overqualified: candidate has 18+ years of experience and holds a Senior Account Executive role, while the position requires only 3 years and is a supporting role to Enterprise AEs, indicating a clear seniority mismatch.
  [Stage4] ✅ PASS  (4/5): Qiang Wang
  [Stage4] ✅ PASS  (3/5): Ichita Obara
  [Stage4] ✅ PASS  (4/5): Juni Y.
  [Stage4] ✅ PASS  (5/5): Taiga Kikuchi
  [Stage4] ✅ PASS  (4/5): Yuzo Nakano
  [Stage4] ✅ PASS  (5/5): Mayuko Seino-Longworth
  [Stage4] ✅ PASS  (4/5): Yuta Nakamura
  [Stage4] ✅ PASS  (4/5): Kohei A.
  [Stage4] ✅ PASS  (4/5): Yusuke Kimura
  [Stage4] ✅ PASS  (4/5): Masaki Takahashi
  [Stage4] ✅ PASS  (3/5): Sumito Tomiyasu
  [Stage4] ✅ PASS  (4/5): Daisuke Ohno
  [Stage4] ✅ PASS  (4/5): Aaron Hiramatsu
  [Stage4] ✅ PASS  (4/5): Yasuhiro Gondaira
  [Stage4] ✅ PASS  (4/5): Tetsushi Takahashi
  [Stage4] ✅ PASS  (4/5): Julio Hirasawa
  [Stage4] ❌ FAIL  (2/5): Keisuke Kuga — Candidate does not clearly demonstrate 3 years of corporate sales experience as required. The profile shows only 1 year 9 months in a sales-focused role, and previous roles are in strategy, operations, and finance, not sales.
  [Stage4] ✅ PASS  (4/5): Ryohei Suda
  [Stage4] ✅ PASS  (4/5): Shotaro Fujino
  [Stage4] ✅ PASS  (4/5): Ryosuke Okumura
  [Stage4] ✅ PASS  (4/5): Jin Hirota
  [Stage4] ✅ PASS  (3/5): Yuya TANAKA
  [Stage4] ✅ PASS  (3/5): Anastasia Dogadina
  [Stage4] ✅ PASS  (4/5): Takeru T.
  [Stage4] ✅ PASS  (4/5): Masaya Ito
  [Stage4] ✅ PASS  (3/5): Kenichi Takimoto
  [Stage4] ❌ FAIL  (2/5): Sho Ueda — Candidate's profile indicates post-sales customer success and onboarding experience, but lacks evidence of 3 years of corporate sales with end-to-end deal execution as required.
  [Stage4] ❌ FAIL  (2/5): Takeshi Ito — Candidate is overqualified with 11 years of experience and a current Head of Corporate Business role, while the position requires 3 years of corporate sales experience and is an individual contributor role, indicating a clear seniority mismatch.
  [Stage4] ✅ PASS  (4/5): 忽那理洋
  [Stage4] ❌ FAIL  (4/5): Miki Oikawa — Multiple consecutive stints under 12 months: Auth0 Strategic Account Executive (7 months) followed by Zscaler Regional Sales Manager (8 months).
  [Stage4] ✅ PASS  (5/5): hirofumi tsutsui
  [Stage4] ❌ FAIL  (2/5): Yoko Saiki — Candidate does not have the required 3 years of corporate sales experience. Her background is in executive management and corporate strategy, not in end-to-end deal execution or sales.
  [Stage4] ✅ PASS  (3/5): Yoshiyuki Kunii
  [Stage4] ✅ PASS  (4/5): Yuki Yokosuka
  [Stage4] ✅ PASS  (4/5): Shota Ietani
  [Stage4] ✅ PASS  (4/5): Shizuka Sato
  [Stage4] ✅ PASS  (4/5): Kota Takeya
  [Stage4] ⚠️  ERROR for Komada Keisuke: Error code: 504
  [Stage4] ❌ FAIL  (2/5): Daisuke Kuramoto — Insufficient demonstrated corporate sales experience (visible closing roles total ~2 years vs required 3 years) and no evidence of Japanese/English language proficiency.
  [Stage4] ✅ PASS  (4/5): Taisei Suzuki
  [Stage4] ⚠️  ERROR for SEIJI HISANO: Error code: 504
  [Stage4] ✅ PASS  (3/5): Kyohei Yamashita
  [Stage4] ❌ FAIL  (2/5): SHOTA TSUKIYAMA — Missing evidence of required Japanese and English communication skills, and lack of demonstrated experience in account prospecting and collaboration with Enterprise AEs.
  [Stage4] ✅ PASS  (4/5): Peiyun Tai
  [Stage4] ✅ PASS  (4/5): Keisuke Kitahara
  [Stage4] ❌ FAIL  (3/5): Sho Sho — Candidate profile does not provide evidence of required Japanese and English communication skills.
  [Stage4] ⚠️  ERROR for Kyohei Goto: Error code: 504
  [Stage4] ⚠️  ERROR for Maho Tokunaga: Error code: 504
  [Stage4] ❌ FAIL  (1/5): Rika Ito — Candidate lacks the required 3 years of corporate sales experience with end-to-end deal execution; background is predominantly in marketing and content, not sales.
  [Stage4] ❌ FAIL  (2/5): Kenshin Fukuda — Candidate does not meet the minimum 3 years of corporate sales experience with end-to-end deal execution. The only full-cycle sales role is the current Corporate Account Executive position held for 2 months. Previous roles include Sales Development (not end-to-end) and Recruiting Advisor (not corporate sales). Additionally, no evidence of exceptional English communication skills as required.
  [Stage4] ✅ PASS  (4/5): Asako Kubo
  [Stage4] ❌ FAIL  (2/5): Yuki Chiba — Candidate's experience is primarily in technical pre-sales and customer success, lacking the required 3 years of demonstrated success in corporate sales with end-to-end deal execution. No evidence of quota-carrying sales or outbound lead generation.
  [Stage4] ✅ PASS  (4/5): Takata Jun
  [Stage4] ✅ PASS  (4/5): Ryusei Takeshita
  [Stage4] ⚠️  ERROR for Harumi Tanaka: Error code: 504
  [Stage4] ✅ PASS  (4/5): Shinobu Ito
  [Stage4] ❌ FAIL  (1/5): Naoki Nishikawa — Candidate does not meet the minimum requirement of 3 years of corporate sales experience with end-to-end deal execution. Background is in HR, customer service, and retail sales.
  [Stage4] ✅ PASS  (4/5): Ryohei Shinagawa
  [Stage4] ❌ FAIL  (2/5): Takuya Takeda — Candidate lacks demonstrated 3 years of corporate sales experience with end-to-end deal execution. His background is primarily in operations, consulting, and leadership roles, with no clear evidence of direct quota-carrying sales.
  [Stage4] ✅ PASS  (4/5): Keijiro Suzuki
  [Stage4] ❌ FAIL  (2/5): Tengmei Zhang — No evidence of Japanese language proficiency, which is a required qualification for the role.
  [Stage4] ✅ PASS  (3/5): Hitomi Furukawa
"""

def parse_audit_results():
    candidates_audit = {}
    for line in raw_text.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        
        # 1. PASS or FAIL matches
        # Format examples:
        # [Stage4] ✅ PASS  (3/5): Kenichi Kato
        # [Stage4] ❌ FAIL  (2/5): Ryohei Miya — Candidate is overqualified...
        # [Stage4] ⚠️  ERROR for Jens Heidelberg: Error code: 504
        
        match_pass_fail = re.search(r'\[Stage4\]\s*(?:✅|❌)\s*(PASS|FAIL)\s+\((\d)/(\d)\):\s*([^\s—:][^—:]*)(?:\s*—\s*(.*))?', line)
        match_error = re.search(r'\[Stage4\]\s*⚠️\s*ERROR for\s+([^:]+):\s*(.*)', line)
        
        if match_pass_fail:
            status = match_pass_fail.group(1)
            score = int(match_pass_fail.group(2))
            name = match_pass_fail.group(4).strip()
            comment = match_pass_fail.group(5)
            comment = comment.strip() if comment else ""
            candidates_audit[name] = {
                "audit_status": status,
                "audit_score": score,
                "audit_comment": comment
            }
        elif match_error:
            name = match_error.group(1).strip()
            comment = match_error.group(2).strip()
            candidates_audit[name] = {
                "audit_status": "ERROR",
                "audit_score": None,
                "audit_comment": comment
            }
    return candidates_audit

def main():
    # Load env & setup database connection
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
    load_dotenv(dotenv_path=env_path)

    # Load ML models
    model_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'artifacts')
    meta_path = os.path.join(model_dir, 'best_model_meta.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'r') as f:
            meta = json.load(f)
        best_model_type = meta.get('best_model_type', 'coxph')
    else:
        best_model_type = 'coxph'
        
    cph = None
    lgb_model = None
    lstm_model = None
    
    if best_model_type == 'coxph':
        cox_path = os.path.join(model_dir, 'cox_survival_model.joblib')
        cph = joblib.load(cox_path)
    elif best_model_type == 'lightgbm':
        lgb_path = os.path.join(model_dir, 'lightgbm_survival_model.joblib')
        lgb_model = joblib.load(lgb_path)
        lgb_times = np.load(os.path.join(model_dir, 'lgb_breslow_times.npy'))
        lgb_survival = np.load(os.path.join(model_dir, 'lgb_breslow_survival.npy'))
    elif best_model_type == 'lstm':
        lstm_path = os.path.join(model_dir, 'lstm_survival_model.pt')
        lstm_model = AttritionLSTM(input_dim=4, hidden_dim=32, num_layers=1)
        lstm_model.load_state_dict(torch.load(lstm_path, map_location='cpu'))
        lstm_model.eval()
        lstm_times = np.load(os.path.join(model_dir, 'lstm_breslow_times.npy'))
        lstm_survival = np.load(os.path.join(model_dir, 'lstm_breslow_survival.npy'))

    # Parse names and audit data from input
    audits = parse_audit_results()
    names = list(audits.keys())

    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        port=os.getenv("DB_PORT", "5433")
    )
    
    query = "SELECT name, profile_url, experience, email FROM candidates_data_science_use WHERE name = ANY(%s)"
    df_db = pd.read_sql(query, conn, params=(names,))
    conn.close()

    print(f"Loaded {len(df_db)} profiles from DB matching {len(names)} parsed candidate names.")

    public_domains = ['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'proton', 'me.com', 'live.com', 'msn.com', 'aol.com']
    
    results = []

    # Map database profiles and compute attrition scores
    for idx, row in df_db.iterrows():
        name = row['name'].strip()
        url = row['profile_url']
        email = row.get('email', '')
        exp_text = row['experience']

        # Parse experience features
        feats = parse_experience(exp_text)

        # Calculate features at start of current stay
        stays = extract_historical_stays(exp_text)
        if stays:
            current_stay = stays[0]
            total_exp = current_stay['total_years_experience']
            num_prev = current_stay['num_previous_companies']
            avg_hist = current_stay['average_historical_tenure_months']
            med_tenure = current_stay['median_tenure_months']
            is_tier_1 = current_stay['is_tier_1']
        else:
            total_exp = feats['total_years_experience']
            num_prev = feats['num_previous_companies']
            avg_hist = 0.1
            med_tenure = 0.0
            is_tier_1 = 0

        # Construct input dataframe for survival model
        input_df_surv = pd.DataFrame([{
            'total_years_experience': total_exp,
            'num_previous_companies': num_prev,
            'average_historical_tenure_months': avg_hist,
            'median_tenure_months': med_tenure,
            'is_tier_1': is_tier_1
        }])

        try:
            if best_model_type == 'coxph':
                hazard = cph.predict_partial_hazard(input_df_surv)[0]
                move_prob = calculate_conditional_probability(cph, input_df_surv, feats['current_tenure_months'])
            elif best_model_type == 'lightgbm':
                log_hazard = lgb_model.predict(input_df_surv)[0]
                hazard = np.exp(log_hazard)
                move_prob = calculate_conditional_probability_custom(
                    lgb_times, lgb_survival, log_hazard, feats['current_tenure_months']
                )
            elif best_model_type == 'lstm':
                if stays:
                    stays_chronological = stays[::-1]
                    seq_len = len(stays_chronological)
                    
                    durations = [s['duration_months'] for s in stays_chronological]
                    is_tier_1_vals = [s['is_tier_1'] for s in stays_chronological]
                    prior_exp_vals = [s['total_years_experience'] * 12.0 for s in stays_chronological]
                    num_prev_vals = [s['num_previous_companies'] for s in stays_chronological]
                    
                    prev_durations = [0.0] * seq_len
                    for j in range(1, seq_len):
                        prev_durations[j] = durations[j-1]
                        
                    X_seq = np.column_stack([
                        is_tier_1_vals,
                        prior_exp_vals,
                        num_prev_vals,
                        prev_durations
                    ]).astype(np.float32)
                else:
                    X_seq = np.zeros((1, 4), dtype=np.float32)
                    
                X_seq_tensor = torch.tensor([X_seq], dtype=torch.float32)
                lengths_tensor = torch.tensor([X_seq.shape[0]], dtype=torch.long)
                
                with torch.no_grad():
                    log_hazards = lstm_model(X_seq_tensor, lengths_tensor)
                    log_hazard = log_hazards[0, -1].item()
                    
                hazard = np.exp(log_hazard)
                move_prob = calculate_conditional_probability_custom(
                    lstm_times, lstm_survival, log_hazard, feats['current_tenure_months']
                )
        except Exception as e:
            hazard = 1.0
            move_prob = 0.5

        # Get LLM audit results for this name
        audit_info = audits.get(name, {"audit_status": "UNKNOWN", "audit_score": None, "audit_comment": ""})

        results.append({
            "name": name,
            "profile_url": url,
            "current_company": feats['current_company'],
            "total_years_experience": feats['total_years_experience'],
            "current_tenure_months": feats['current_tenure_months'],
            "move_probability": float(move_prob),
            "hazard_score": float(hazard),
            "audit_status": audit_info["audit_status"],
            "audit_score": audit_info["audit_score"],
            "audit_comment": audit_info["audit_comment"]
        })

    # Convert to DataFrame
    res_df = pd.DataFrame(results)

    # Deduplicate results if a candidate has multiple entries, keep the one with larger experience or just keep all.
    # Actually, keeping all is better, but let's see if we want to sort them.
    # Let's sort by Move Probability descending so candidates most likely to leave are listed first
    res_df = res_df.sort_values(by="move_probability", ascending=False)

    # Save to CSV
    output_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "attrition_scoring_results.csv")
    res_df.to_csv(output_path, index=False)
    print(f"Successfully saved {len(res_df)} scored candidates to {output_path}")

    # Generate a beautiful Markdown table for artifact
    markdown_lines = []
    markdown_lines.append("# Candidate Attrition Scoring Results")
    markdown_lines.append("")
    markdown_lines.append("This table presents the attrition scoring (LightGBM Move Probability and Cox Proportional Hazards Score) along with the Stage 4 LLM Audit Verdicts.")
    markdown_lines.append("")
    markdown_lines.append("| Candidate Name | Profile URL | Current Company | Total Exp (Yrs) | Tenure (Mos) | Attrition Prob | Hazard Score | Audit Status | Audit Score |")
    markdown_lines.append("| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |")

    for _, r in res_df.iterrows():
        # Clean URL link text
        profile_link = f"[LinkedIn Link]({r['profile_url']})"
        audit_score_str = f"{r['audit_score']}/5" if pd.notnull(r['audit_score']) else "-"
        # Emoji for status
        if r['audit_status'] == 'PASS':
            status_str = "✅ PASS"
        elif r['audit_status'] == 'FAIL':
            status_str = "❌ FAIL"
        else:
            status_str = "⚠️ ERROR"
            
        markdown_lines.append(
            f"| {r['name']} | {profile_link} | {r['current_company']} | {r['total_years_experience']:.1f} | {r['current_tenure_months']:.1f} | **{r['move_probability']:.2%}** | {r['hazard_score']:.3f} | {status_str} | {audit_score_str} |"
        )

    # Write artifact file
    # We will write it to the default artifact path in the App Data Directory
    artifact_dir = "/Users/zarb/.gemini/antigravity-ide/brain/e82af31b-2903-4b36-aad3-d6c7ead69910"
    os.makedirs(artifact_dir, exist_ok=True)
    with open(os.path.join(artifact_dir, "attrition_scoring_results.md"), "w") as f:
        f.write("\n".join(markdown_lines))
    print(f"Successfully wrote artifact to {os.path.join(artifact_dir, 'attrition_scoring_results.md')}")

if __name__ == '__main__':
    main()
