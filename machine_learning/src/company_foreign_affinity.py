"""
Derive a per-company "foreign affinity" score for the Japan labour market —
the 外資系 / domestic axis — without a single LLM call.

Why not an LLM
--------------
Labelling ~890k distinct Japan-employing company strings with a model is the
obvious approach and the wrong one: it costs real money per company, it has to
be redone as the corpus grows, and it cannot be audited. Three measurements
said a cheaper route exists.

  1. Name morphology is useless on its own. 79.4% of Japan spells carry a
     pure-Latin company name. 合同会社 / ジャパン / 日本+katakana together
     cover 1.2% of employment mass. Those markers are ~100% precise where they
     fire, so they make excellent seeds and a hopeless classifier.

  2. Cross-market share works but confounds. Accenture is 11% Japan-located,
     Google 13%, IBM 20%, against Rakuten 94% and NTTデータ 99.7%. Clean —
     except Japanese *multinationals* land in the middle: Toyota 48.5%,
     Sony 73.3%. Low Japan share means "multinational", not "foreign".

  3. Hand-labelling cannot carry it. The top 1,000 companies are only 24.5% of
     Japan spells. The tail is where the mass is.

What does work is the careers themselves. People who worked at Google in Japan
also worked at Microsoft, Amazon, AWS, IBM, Apple, Accenture, Salesforce,
Oracle, Twitter and ByteDance. People at 日立製作所 have almost no
co-employment at all above threshold — they stay. Segment membership
propagates along co-employment edges, and it does so on Latin names, which is
the 79% that morphology cannot touch.

Method
------
  Stage 1  Identity resolution. Google / Google Japan / Google合同会社 /
           グーグル are four strings and one employer. Strip legal forms,
           trailing Japan markers and punctuation.
  Stage 2  Signals per resolved company: japan_share, morphology flags,
           corpus volume.
  Stage 3  Label propagation over the co-employment graph, seeded by
           morphology + a hand-authored fixture (below). Iterated to a fixed
           point, seeds clamped.
  Stage 4  Validation on a held-out slice of the fixture, reported as
           precision/recall AND coverage by employment mass — company-count
           accuracy would flatter a long tail.

Output is `company_foreign_affinity`: a score in [0,1] plus an observation
count, deliberately NOT a boolean. Toyota genuinely sits between, and a flag
would be asserting something false about it.

What this actually measures
---------------------------
Read this before using the column. It is NOT legal ownership.

Co-employment measures which part of the labour market an employer draws from
and loses people to. That correlates strongly with foreign ownership, which is
why the method works, but the two come apart and the output follows the
labour market every time:

  Indeed        0.621 (37 neighbours) — Recruit-owned, so Japanese by any
                ownership test, but it hires and loses people to the
                international tech segment, and the score says so.
  Sharp         0.407 (24) — Foxconn-owned, run on Japanese norms. Mid.
  Toyota, Sony  domestic in this corpus despite being multinationals.

For flight-risk modelling that is the more useful quantity: what predicts
mobility is the market someone's employer competes in, not its shareholder
register. But do not label this column 外資系 in a UI, and do not use it to
answer "is this company foreign-owned" — for Indeed it would be wrong.

Other limits
------------
  - Verdicts backed by fewer than --min-evidence labelled co-employers are
    withdrawn, not emitted. 中外製薬 came back 1.000 off one neighbour and
    Nissan 0.948 off three before this gate existed; both are now NULL.
  - Companies below --min-spells get no score at all.
  - Scripts fragment: ソフトバンク and softbank normalise apart, so a company
    seeded in one script is unseeded in the other. The fixture lists both
    forms for the majors; the tail still splits.
  - The seed fixture is my own general knowledge, not a register. It seeds and
    it validates; it is never the classifier.

Measured: 0.925 accuracy on a 25% held-out slice of the fixture, 3,908
companies scored, 35.3% of Japan employment mass.

Usage
-----
    python -m machine_learning.src.company_foreign_affinity --build
    python -m machine_learning.src.company_foreign_affinity --validate
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv

load_dotenv(
    dotenv_path=os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
    )
)


def db_config() -> dict:
    return dict(
        dbname=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5433"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Seed fixture — hand-authored, deliberately unambiguous
# ─────────────────────────────────────────────────────────────────────────────
#
# These are written in *normalised* form (see NORMALISE_SQL). Chosen for being
# beyond argument on the ownership question. Excluded on purpose: Nissan
# (Renault alliance), Sharp (Foxconn-owned), 中外製薬 (Roche-controlled),
# Indeed (Recruit-owned), Nidec, SoftBank Vision portfolio — all genuinely
# contested, so they belong in the evaluation set of a later pass, not in the
# seeds of this one.

SEED_FOREIGN = """
google microsoft amazon amazonwebservices apple meta facebook salesforce oracle
sap ibm dell hewlettpackard hp cisco intel adobe vmware servicenow workday zoom
twitter linkedin uber airbnb netflix spotify paypal nvidia qualcomm broadcom
micron appliedmaterials lamresearch asml siemens bosch ericsson nokia samsung
tsmc infineon texasinstruments autodesk redhat mongodb databricks snowflake
paloaltonetworks fortinet crowdstrike splunk akamai cloudflare atlassian twilio
datadog elastic github unity mckinsey bain bostonconsultinggroup accenture
deloitte pwc pricewaterhousecoopers ernstyoung kpmg goldmansachs morganstanley
jpmorgan citigroup citi bankofamerica barclays creditsuisse ubs deutschebank
bnpparibas hsbc standardchartered blackrock bloomberg spglobal moodys visa
mastercard americanexpress aig allianz axa aon marsh metlife pfizer novartis
roche merck astrazeneca glaxosmithkline sanofi bayer johnsonjohnson abbott
medtronic bostonscientific elililly bristolmyerssquibb amgen proctergamble
unilever nestle cocacola pepsico mondelez kelloggs mars loreal esteelauder
danone kraftheinz colgatepalmolive kimberlyclark 3m generalelectric honeywell
caterpillar boeing airbus michelin lvmh chanel hermes gucci burberry nike
adidas hm inditex zara ikea walmart costco bytedance stripe
"""

SEED_DOMESTIC = """
トヨタ自動車 toyotamotor honda ホンダ 本田技研工業 sony ソニー panasonic
パナソニック 日立製作所 hitachi 東芝 toshiba 三菱電機 mitsubishielectric
富士通 fujitsu nec 日本電気 キヤノン canon ニコン nikon リコー ricoh
村田製作所 murata キーエンス keyence ファナック fanuc デンソー denso
ブリヂストン bridgestone 信越化学工業 東レ toray 旭化成 asahikasei
三菱ケミカル 住友化学 花王 kao 資生堂 shiseido 味の素 ajinomoto キリン
kirin アサヒビール サントリー suntory 明治 日清食品 セブンイレブン
セブンアイホールディングス イオン aeon ファーストリテイリング fastretailing
ユニクロ uniqlo 楽天 rakuten ソフトバンク softbank ntt 日本電信電話
nttデータ nttdata nttドコモ kddi 野村證券 nomura 大和証券 daiwasecurities
三菱ufj銀行 三菱ufjフィナンシャルグループ 三井住友銀行 smbc みずほ銀行
mizuho 日本生命保険 東京海上日動火災保険 tokiomarine 電通 dentsu 博報堂
hakuhodo リクルート recruit サイバーエージェント cyberagent dena グリー
gree ミクシィ mixi line ヤフー yahoojapan メルカリ mercari freee
マネーフォワード moneyforward smarthr サイボウズ cybozu 日本郵政 jr東日本
東日本旅客鉄道 jr東海 全日本空輸 ana 日本航空 jal 三菱商事 三井物産 伊藤忠商事
住友商事 丸紅 marubeni 清水建設 大成建設 鹿島建設 大林組 三菱地所 三井不動産
積水ハウス 大和ハウス工業 コマツ komatsu クボタ kubota ヤマハ yamaha カシオ
casio オリンパス olympus テルモ terumo 武田薬品工業 takeda アステラス製薬
astellas 第一三共 daiichisankyo エーザイ eisai
"""


def seed_frame() -> pd.DataFrame:
    f = [(w, 1.0) for w in SEED_FOREIGN.split()]
    d = [(w, 0.0) for w in SEED_DOMESTIC.split()]
    df = pd.DataFrame(f + d, columns=["norm", "seed"])
    return df.drop_duplicates("norm").reset_index(drop=True)


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1/2 — identity resolution and per-company signals
# ─────────────────────────────────────────────────────────────────────────────
#
# Verified on the corpus: this collapses Google's 8 variants (incl.
# "Google Japan" and "Google合同会社") and IBM's 17 into one key each.
#
# The trailing-token strip is anchored at end-of-string on purpose. Stripping
# "japan" anywhere would turn "Japan Airlines" into "airlines" and
# "Japan Tobacco" into "tobacco" — two large domestic employers silently
# merged into whatever else normalises the same way.
NORMALISE_SQL = r"""
regexp_replace(
  regexp_replace(
    regexp_replace(lower(company),
      '(株式会社|合同会社|有限会社|合資会社|㈱|\(株\))', '', 'g'),
    '[[:space:],.\-–—_/()·・]*\m(inc|incorporated|ltd|limited|llc|llp|plc|corp|corporation|company|co|kk|gmbh|pty|ag|nv|sa|srl|bv|group|holdings|japan|ジャパン)\M\.?[[:space:]]*$',
    '', 'g'),
  '[^a-z0-9ぁ-んァ-ヿ㐀-䶵一-鿿]', '', 'g')
"""

BUILD_COMPANIES_SQL = f"""
DROP TABLE IF EXISTS company_norm_map;
CREATE TABLE company_norm_map AS
SELECT company, {NORMALISE_SQL} AS norm
FROM (SELECT DISTINCT company FROM flight_risk_spells
      WHERE company IS NOT NULL AND company <> '') s;
CREATE INDEX ON company_norm_map (company);
CREATE INDEX ON company_norm_map (norm);
ANALYZE company_norm_map;

DROP TABLE IF EXISTS company_signals;
CREATE TABLE company_signals AS
SELECT
    m.norm,
    count(*)                                        AS spells_total,
    count(*) FILTER (WHERE s.market = 'Japan')      AS spells_jp,
    -- Signal A. Low share ⇒ multinational (NOT necessarily foreign).
    (count(*) FILTER (WHERE s.market = 'Japan'))::float8 / count(*) AS japan_share,
    -- Signal B. Near-certain foreign affiliate where it fires; ~1.2% of mass.
    bool_or(s.company LIKE '%合同会社%'
         OR s.company LIKE '%ジャパン%'
         OR s.company ~ '日本[ァ-ヿ]'
         OR s.company ~* '\\mk\\.k\\.?\\M')          AS morph_foreign,
    -- Kanji in every observed spelling ⇒ Japanese-language entity name.
    bool_and(s.company ~ '[㐀-䶵一-鿿]')             AS morph_all_kanji,
    min(s.company)                                  AS example_name
FROM flight_risk_spells s
JOIN company_norm_map m ON m.company = s.company
WHERE m.norm <> ''
GROUP BY m.norm;
ALTER TABLE company_signals ADD PRIMARY KEY (norm);
CREATE INDEX ON company_signals (spells_jp);
ANALYZE company_signals;
"""


def build_companies(conn) -> None:
    print("[1/4] resolving company identities and computing signals…")
    with conn.cursor() as cur:
        cur.execute(BUILD_COMPANIES_SQL)
    conn.commit()
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM company_signals WHERE spells_jp > 0")
        print(f"      {cur.fetchone()[0]:,} companies with Japan presence")


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — co-employment graph and propagation
# ─────────────────────────────────────────────────────────────────────────────

EDGES_SQL = """
WITH jp AS (
    SELECT DISTINCT s.profile_url, m.norm
    FROM flight_risk_spells s
    JOIN company_norm_map m ON m.company = s.company
    JOIN company_signals g  ON g.norm = m.norm
    WHERE s.market = 'Japan' AND g.spells_jp >= %(min_spells)s AND m.norm <> ''
)
SELECT a.norm AS a, b.norm AS b, count(*)::int AS w
FROM jp a JOIN jp b ON a.profile_url = b.profile_url AND a.norm < b.norm
GROUP BY a.norm, b.norm
HAVING count(*) >= %(min_edge)s
"""

# Distinct Japan-located people per company — the denominator for cosine
# normalisation. Deliberately counts people, not spells: someone promoted
# three times at one employer is one person's worth of overlap, not three.
NODE_PEOPLE_SQL = """
SELECT m.norm, count(DISTINCT s.profile_url)::int AS n_people
FROM flight_risk_spells s
JOIN company_norm_map m ON m.company = s.company
JOIN company_signals g  ON g.norm = m.norm
WHERE s.market = 'Japan' AND g.spells_jp >= %(min_spells)s AND m.norm <> ''
GROUP BY m.norm
"""


def propagate(
    nodes: pd.DataFrame, edges: pd.DataFrame, alpha: float, iters: int
) -> tuple[np.ndarray, np.ndarray]:
    """
    Weighted vote over *seeded* neighbours, expanded hop by hop.

    Returns (score, n_evidence) where n_evidence is how many scored neighbours
    backed each verdict — nodes with none keep NaN rather than a guess.

    Why not fixed-point propagation
    -------------------------------
    That was the first implementation and it failed in a way worth recording.
    Iterating `score = a*prior + (1-a)*(W@score)/rowsum` with clamped seeds
    regresses to the graph mean on a dense graph, and this graph is very dense:
    every large Japanese employer shares people with every other. The result
    was every unseeded company compressed into 0.38-0.55 — McKinsey at 0.546,
    Accenture at 0.543, Uniqlo at 0.530, Toyota at 0.491. Correctly ordered in
    places, but with no usable separation and a threshold that would have been
    pure coin-flip.

    Voting only over neighbours whose label is already known avoids mixing in
    the undecided middle, which is what was washing the signal out. Unscored
    nodes stay unscored and get filled on a later hop, or not at all.
    """
    from scipy.sparse import coo_matrix

    idx = {n: i for i, n in enumerate(nodes["norm"])}
    n = len(idx)
    ia = edges["a"].map(idx).to_numpy()
    ib = edges["b"].map(idx).to_numpy()
    w = edges["w"].to_numpy(dtype=float)

    # Cosine-normalise: w_ij / sqrt(n_i * n_j).
    #
    # Raw co-employment counts measure employer size far more than they
    # measure affinity. Accenture shares people with everyone in Japan because
    # Accenture is enormous, so on raw counts every neighbourhood is dominated
    # by the same handful of giants and the graph says nothing. Dividing by the
    # geometric mean of the endpoints' headcounts asks the right question:
    # what fraction of these two workforces overlap.
    people = nodes["n_people"].to_numpy(dtype=float)
    people[people <= 0] = 1.0
    w = w / np.sqrt(people[ia] * people[ib])
    W = coo_matrix((np.concatenate([w, w]),
                    (np.concatenate([ia, ib]), np.concatenate([ib, ia]))),
                   shape=(n, n)).tocsr()

    seed = nodes["seed"].to_numpy(dtype=float)
    is_seed = ~np.isnan(seed)

    score = np.where(is_seed, seed, np.nan)
    evidence = np.where(is_seed, np.inf, 0.0)

    # `alpha` now damps each successive hop: a verdict inferred two steps from
    # any real label is pulled toward 0.5 in proportion to its distance.
    for hop in range(iters):
        known = ~np.isnan(score)
        if known.all():
            break
        vals = np.where(known, score, 0.0)
        num = W @ vals                      # Σ w_ij · score_j over known j
        den = W @ known.astype(float)       # Σ w_ij       over known j
        cnt = (W > 0) @ known.astype(float)  # how many known neighbours

        fill = (~known) & (den > 0) & (cnt >= 1)
        if not fill.any():
            break
        raw = num[fill] / den[fill]
        shrink = alpha ** hop               # hop 0 undamped, later hops pulled in
        score[fill] = 0.5 + (raw - 0.5) * shrink
        evidence[fill] = cnt[fill]

    return np.clip(score, 0.0, 1.0), evidence


def build_scores(conn, min_spells: int, min_edge: int, alpha: float, iters: int,
                 holdout_frac: float, min_evidence: int) -> pd.DataFrame:
    print(f"[2/4] loading companies (>= {min_spells} Japan spells)…")
    nodes = pd.read_sql(
        "SELECT norm, spells_total, spells_jp, japan_share, morph_foreign,"
        " morph_all_kanji, example_name FROM company_signals WHERE spells_jp >= %(m)s",
        conn, params={"m": min_spells},
    )
    print(f"      {len(nodes):,} nodes")

    print(f"[3/4] building co-employment edges (>= {min_edge} shared careers)…")
    edges = pd.read_sql(
        EDGES_SQL, conn, params={"min_spells": min_spells, "min_edge": min_edge}
    )
    print(f"      {len(edges):,} edges")

    ppl = pd.read_sql(NODE_PEOPLE_SQL, conn, params={"min_spells": min_spells})
    nodes = nodes.merge(ppl, on="norm", how="left")
    nodes["n_people"] = nodes["n_people"].fillna(1).astype(float)

    # Seeds: the hand fixture, plus morphology where it fires. Morphology is
    # one-directional — it can only assert foreign, never domestic.
    seeds = seed_frame()
    # holdout_frac=0 for a production build: withholding a quarter of the
    # seeds to score a number costs real accuracy in the artefact that ships.
    # --validate is the run that measures; --build is the run that delivers.
    holdout = (seeds.sample(frac=holdout_frac, random_state=42).index
               if holdout_frac > 0 else seeds.index[:0])
    train_seeds = seeds.drop(index=holdout)

    nodes = nodes.merge(train_seeds, on="norm", how="left")
    nodes.loc[nodes["seed"].isna() & nodes["morph_foreign"], "seed"] = 1.0

    # Prior: neutral.
    #
    # This used to be built from japan_share, and it was actively wrong. A
    # Japanese multinational has a LOW Japan share for the same reason a
    # foreign firm does — Uniqlo sits at 0.29, below Toyota's 0.64 — so the
    # prior pushed Fast Retailing to 0.56, the foreign side of the line, while
    # Toyota landed at 0.44. That is the confound from the module docstring
    # leaking straight into the output instead of being controlled for.
    #
    # japan_share is still reported as its own column, where a reader can
    # interpret it knowing what it does and does not mean. It no longer gets
    # a vote here. The graph carries the signal; the seeds anchor it.
    nodes["prior"] = 0.5
    nodes.loc[nodes["morph_all_kanji"] & nodes["seed"].isna(), "prior"] = 0.35

    n_seed = int(nodes["seed"].notna().sum())
    print(f"[4/4] propagating from {n_seed:,} seeded nodes…")
    score, evidence = propagate(nodes, edges, alpha, iters)
    nodes["foreign_affinity"] = score
    nodes["n_evidence"] = np.where(np.isinf(evidence), -1, evidence)

    # Gate on evidence. A verdict backed by one co-employer is noise: 中外製薬
    # came back 1.000 off a single neighbour and 三菱商事 0.612 off one, both
    # confidently wrong-ish. Below the threshold we return NULL, because "no
    # opinion" is a usable answer and a fabricated 0.61 is not.
    thin = (nodes["n_evidence"] >= 0) & (nodes["n_evidence"] < min_evidence)
    nodes.loc[thin, "foreign_affinity"] = np.nan
    print(f"      {int(thin.sum()):,} verdicts withdrawn (< {min_evidence} labelled neighbours)")

    scored = nodes["foreign_affinity"].notna()
    print(f"      {int(scored.sum()):,}/{len(nodes):,} scored; "
          f"{int((~scored).sum()):,} left unscored (no labelled neighbour)")

    # Report against the held-out fixture rows.
    held = seeds.loc[holdout]
    ev = nodes.merge(held.rename(columns={"seed": "truth"}), on="norm", how="inner")
    if len(ev) >= 10:
        pred = (ev["foreign_affinity"] >= 0.5).astype(float)
        acc = (pred == ev["truth"]).mean()
        print(f"\n  held-out fixture: {len(ev)} companies, accuracy {acc:.3f}")

    return nodes


WRITE_SQL = """
DROP TABLE IF EXISTS company_foreign_affinity;
CREATE TABLE company_foreign_affinity (
    norm             TEXT PRIMARY KEY,
    example_name     TEXT,
    spells_total     INTEGER,
    spells_jp        INTEGER,
    japan_share      REAL,
    morph_foreign    BOOLEAN,
    -- [0,1]. NOT a boolean and NOT a legal ownership fact: Japanese
    -- multinationals score mid-range by construction. See module docstring.
    foreign_affinity REAL,
    -- How many already-labelled co-employers backed this verdict.
    -- -1 = hand seed. NULL score = no labelled neighbour, left unscored
    -- rather than guessed.
    n_evidence       REAL,
    is_seed          BOOLEAN,
    built_at         TIMESTAMP DEFAULT NOW()
);
"""


def write(conn, nodes: pd.DataFrame) -> None:
    from psycopg2.extras import execute_values

    with conn.cursor() as cur:
        cur.execute(WRITE_SQL)
        rows = [
            (r.norm, r.example_name, int(r.spells_total), int(r.spells_jp),
             float(r.japan_share), bool(r.morph_foreign),
             None if pd.isna(r.foreign_affinity) else float(r.foreign_affinity),
             float(r.n_evidence), bool(pd.notna(r.seed)))
            for r in nodes.itertuples()
        ]
        execute_values(
            cur,
            "INSERT INTO company_foreign_affinity (norm, example_name, spells_total,"
            " spells_jp, japan_share, morph_foreign, foreign_affinity,"
            " n_evidence, is_seed) VALUES %s", rows, page_size=5000,
        )
        cur.execute("CREATE INDEX ON company_foreign_affinity (foreign_affinity)")
    conn.commit()
    print(f"\nwrote {len(nodes):,} rows to company_foreign_affinity")


def coverage(conn) -> None:
    """Coverage by employment mass, not by company count — a long tail makes
    company-count coverage look far better than it is."""
    q = """
    SELECT
      (SELECT sum(spells_jp) FROM company_signals)                       AS all_jp,
      (SELECT sum(spells_jp) FROM company_foreign_affinity
         WHERE foreign_affinity IS NOT NULL)                             AS scored_jp,
      (SELECT count(*) FROM company_foreign_affinity
         WHERE foreign_affinity IS NOT NULL)                             AS scored_cos
    """
    with conn.cursor() as cur:
        cur.execute(q)
        all_jp, scored_jp, scored_cos = cur.fetchone()
    # sum() over an integer column comes back as Decimal; mixing it with a
    # float literal raises rather than coercing.
    all_jp, scored_jp = float(all_jp or 0), float(scored_jp or 0)
    pct = 100.0 * scored_jp / all_jp if all_jp else 0.0
    print(f"coverage: {scored_cos:,} companies, "
          f"{scored_jp:,.0f}/{all_jp:,.0f} Japan spells ({pct:.1f}% of mass)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--skip-resolve", action="store_true",
                    help="reuse company_norm_map / company_signals")
    ap.add_argument("--min-spells", type=int, default=5)
    ap.add_argument("--min-edge", type=int, default=2)
    ap.add_argument("--alpha", type=float, default=0.7,
                    help="per-hop damping; a verdict N hops from a real label is pulled toward 0.5 by alpha**N")
    ap.add_argument("--iters", type=int, default=40)
    ap.add_argument("--holdout", type=float, default=0.0,
                    help="fraction of seeds withheld to measure accuracy; 0 for production builds")
    ap.add_argument("--min-evidence", type=int, default=5,
                    help="labelled neighbours required before a score is emitted")
    args = ap.parse_args()

    if not args.build:
        ap.print_help()
        return 2

    conn = psycopg2.connect(**db_config())
    try:
        if not args.skip_resolve:
            build_companies(conn)
        nodes = build_scores(conn, args.min_spells, args.min_edge,
                             args.alpha, args.iters, args.holdout, args.min_evidence)
        write(conn, nodes)
        coverage(conn)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
