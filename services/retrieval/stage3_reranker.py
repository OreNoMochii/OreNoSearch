"""
stage3_reranker.py — Local cross-encoder reranking with BAAI/bge-reranker-v2-m3
                      + domain-aware post-scoring adjustments.

Takes the top-N candidates from Stage 2 and returns the top-K
most semantically aligned with the JD.

Key improvements over naive reranking:
  1. Text blob is restructured to front-load CURRENT ROLE and RECENT
     EXPERIENCE so the cross-encoder weighs recent trajectory most heavily.
  2. After cross-encoder scoring, a post-processing layer applies
     domain-coherence, seniority-alignment, and career-trajectory
     penalties/boosts to ensure the final shortlist contains candidates
     whose current career arc is deeply aligned with the JD — not just
     candidates who happen to have a keyword match somewhere in their history.
"""
import re
import threading
import asyncio
import datetime
import os
import pathlib
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
from config import RERANKER_MODEL

_lock = threading.Lock()
_reranker = None

# Dedicated single-worker pool for cross-encoder inference.
#
# Reranking previously ran on asyncio's default executor, which has up to
# min(32, cpu+4) workers. Two concurrent /search requests therefore ran two full
# inference passes over the *same* model object at once: they contended for the
# same cores (or the same GPU stream), so both finished later than if they had
# been serialised, and peak memory doubled. One worker means one pass at a time,
# queued rather than interleaved.
_rerank_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="reranker")

# Batch size for CrossEncoder.predict. Was left to the library default
# regardless of how many pairs Stage 2 handed over.
_RERANK_BATCH_SIZE = 32

# Generic company-name suffixes, stripped before same-employer comparison.
_GENERIC_SUFFIXES = re.compile(
    r'\b(inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|株式会社|k\.k\.?|s\.a\.?|b\.v\.?|plc\.?|pty\.?'
    r'|group|holdings|japan|international|global)\b',
    re.IGNORECASE,
)


def _get_reranker():
    global _reranker
    if _reranker is None:
        with _lock:
            if _reranker is None:
                from sentence_transformers import CrossEncoder
                print(f"[Reranker] Loading {RERANKER_MODEL} … (first run downloads ~570 MB)")
                _reranker = CrossEncoder(RERANKER_MODEL)
                print(f"[Reranker] Model loaded ✓")
    return _reranker


# ─────────────────────────────────────────────────────────────────────────────
# Text blob construction — front-load current role for cross-encoder
# ─────────────────────────────────────────────────────────────────────────────
def _build_text_blob(candidate: dict) -> str:
    """
    Build a structured text blob that front-loads current role information
    so the cross-encoder weights recent career trajectory most heavily.
    """
    headline = (candidate.get("headline") or "").strip()
    company  = (candidate.get("current_company") or "").strip()
    summary  = (candidate.get("summary") or "").strip()[:500]
    exp      = (candidate.get("experience") or "").strip()
    skills   = (candidate.get("skills") or "").strip()[:300]
    location = (candidate.get("location") or "").strip()

    # Extract first (most recent) experience block — typically separated by newlines
    recent_exp = ""
    rest_exp = ""
    if exp:
        # Split by common delimiters: double newline, or lines starting with company/role patterns
        blocks = re.split(r'\n{2,}', exp)
        if len(blocks) >= 1:
            recent_exp = blocks[0][:400]
        if len(blocks) >= 2:
            rest_exp = " ".join(blocks[1:])[:400]

    parts = []

    # MOST IMPORTANT: current role + company (cross-encoder sees this first)
    if headline:
        parts.append(f"CURRENT ROLE: {headline}")
    if company:
        parts.append(f"CURRENT COMPANY: {company}")
    if location:
        parts.append(f"LOCATION: {location}")

    # SECOND: most recent experience details
    if recent_exp:
        parts.append(f"RECENT EXPERIENCE: {recent_exp}")

    # THIRD: summary and skills
    if summary:
        parts.append(f"PROFILE: {summary}")
    if skills:
        parts.append(f"SKILLS: {skills}")

    # FOURTH: older experience (truncated, lower weight)
    if rest_exp:
        parts.append(f"PRIOR EXPERIENCE: {rest_exp}")

    return " | ".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
# Post-rerank scoring adjustments
# ─────────────────────────────────────────────────────────────────────────────

def _extract_domain_keywords(text: str) -> set[str]:
    """Extract meaningful lowercased tokens from text for domain matching."""
    if not text:
        return set()
    # Remove common stop words and keep meaningful tokens
    stop = {'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was',
            'will', 'have', 'has', 'been', 'not', 'but', 'they', 'their', 'his',
            'her', 'our', 'who', 'which', 'what', 'when', 'where', 'how', 'all',
            'each', 'any', 'more', 'than', 'also', 'into', 'over', 'about',
            'such', 'only', 'other', 'can', 'may', 'must', 'should', 'would',
            'could', 'years', 'year', 'experience', 'ability', 'strong', 'work',
            'working', 'team', 'role', 'company', 'business', 'including', 'etc',
            'related', 'based', 'new', 'well', 'good', 'great', 'best', 'high',
            'key', 'skills', 'required', 'preferred', 'minimum', 'requirements',
            'responsibilities', 'qualifications'}
    words = re.findall(r'\b[a-z]{3,}\b', text.lower())
    return {w for w in words if w not in stop}


def _estimate_years_from_experience(exp_text: str) -> float:
    """
    Rough estimate of total years of experience from the experience text.
    Looks for year ranges like "2018 - 2023" or "2018 - Present".
    """
    if not exp_text:
        return 0.0

    current_year = datetime.datetime.now().year

    # Find year patterns: "2018 - 2023", "2018 – Present", "Jan 2018 - Dec 2023"
    year_ranges = re.findall(
        r'(\d{4})\s*[-–—to]+\s*(\d{4}|[Pp]resent|[Cc]urrent|[Nn]ow|今)',
        exp_text
    )

    if not year_ranges:
        # Fallback: count unique years mentioned
        years_mentioned = set(re.findall(r'\b(19\d{2}|20\d{2})\b', exp_text))
        if len(years_mentioned) >= 2:
            return max(int(y) for y in years_mentioned) - min(int(y) for y in years_mentioned)
        return 0.0

    total = 0.0
    for start_str, end_str in year_ranges:
        start = int(start_str)
        end = current_year if not end_str[0].isdigit() else int(end_str)
        total += max(0, end - start)

    return total


# ─────────────────────────────────────────────────────────────────────────────
# Seniority tier detection from job title / headline
# ─────────────────────────────────────────────────────────────────────────────

# Tier 4 = C-Suite / Executive (CEO, CTO, COO, CMO, CRO, 代表取締役, 執行役員)
# Tier 3 = Director / VP / Head (VP, SVP, EVP, Director, Head of, 部長, 本部長)
# Tier 2 = Manager / Lead (Manager, Team Lead, Supervisor, 課長, リーダー)
# Tier 1 = IC / Individual Contributor (everything else)

_TIER4_PATTERNS = re.compile(
    r'\b(chief|ceo|cto|cfo|coo|cmo|cro|cio|cpo|cso|president|founder|co-founder'
    r'|executive\s+director'
    r'|代表取締役|執行役員|取締役|社長|副社長)\b',
    re.IGNORECASE
)

_TIER3_PATTERNS = re.compile(
    r'\b(vice\s+president|senior\s+vice\s+president|svp|evp|avp'
    r'|managing\s+director|general\s+manager|partner'
    r'|director|head\s+of|regional\s+head|country\s+head|global\s+head'
    r'|vp\b|本部長|事業部長|部長|統括)\b',
    re.IGNORECASE
)

_TIER2_PATTERNS = re.compile(
    r'\b(manager|team\s+lead|lead|supervisor|principal|senior\s+manager'
    r'|group\s+manager|assistant\s+director|associate\s+director'
    r'|課長|マネージャー|リーダー|主任)\b',
    re.IGNORECASE
)

def _detect_seniority_tier(headline: str) -> int:
    """
    Detect the seniority tier of a candidate from their headline/title.
    Returns 1 (IC), 2 (Manager), 3 (Director/VP/Head), or 4 (C-Suite).
    """
    if not headline:
        return 1
    if _TIER4_PATTERNS.search(headline):
        return 4
    if _TIER3_PATTERNS.search(headline):
        return 3
    if _TIER2_PATTERNS.search(headline):
        return 2
    return 1


def _jd_seniority_to_tier(seniority_level: str) -> int:
    """Map the Stage 1 seniority_level string to a tier number."""
    s = (seniority_level or "").lower().strip()
    if s in ("executive", "c-level", "c-suite"):
        return 4
    if s in ("senior", "director", "head"):
        return 3
    if s in ("manager",):
        return 2
    # Junior, Mid-Level, entry-level, IC, or unknown → tier 1 (IC)
    # Mid-Level is an Individual Contributor level, not a management level
    return 1


def _compute_adjustments(
    candidate: dict,
    jd_domain_keywords: set[str],
    role_synonyms: list[str],
    min_years: int,
    max_years: int,
    primary_domain: str,
    seniority_level: str = "",
) -> tuple[float, str]:
    """
    Compute a multiplicative adjustment factor for a candidate's cross-encoder score.

    Returns (multiplier, reason_string) where:
      - multiplier > 1.0 = boost
      - multiplier < 1.0 = penalty
      - multiplier = 1.0 = neutral

    Penalty/boost signals:
      1. Current role alignment: Is the candidate's CURRENT headline in the JD's domain?
      2. Seniority / years alignment: Is the candidate's experience proportionate?
      3. Career coherence: Does the candidate's career show consistent domain focus?
      4. Seniority tier mismatch: Is a VP/Head being proposed for an IC role or vice versa?
    """
    headline = (candidate.get("headline") or "").lower()
    experience = (candidate.get("experience") or "").lower()
    skills_text = (candidate.get("skills") or "").lower()
    summary = (candidate.get("summary") or "").lower()
    multiplier = 1.0
    reasons = []

    # ── 1. Current Role Alignment ────────────────────────────────────────────
    headline_keywords = _extract_domain_keywords(headline)
    domain_lower = primary_domain.lower() if primary_domain else ""
    domain_tokens = set(domain_lower.split()) if domain_lower else set()

    role_tokens = set()
    for syn in role_synonyms:
        role_tokens.update(syn.lower().split())
    role_tokens.discard("")

    headline_overlap = len(headline_keywords & (jd_domain_keywords | domain_tokens | role_tokens))

    if headline and headline_overlap == 0:
        multiplier *= 0.4
        reasons.append(f"current_role_mismatch(headline='{headline[:50]}')")
    elif headline_overlap >= 2:
        multiplier *= 1.15
        reasons.append("current_role_strong_match")

    # ── 2. Seniority / Experience Alignment ──────────────────────────────────
    estimated_years = _estimate_years_from_experience(experience)

    if estimated_years > 0 and max_years < 90:
        if estimated_years > max_years * 2.5:
            multiplier *= 0.5
            reasons.append(f"overqualified({estimated_years:.0f}y vs max {max_years}y)")
        elif estimated_years > max_years * 1.8:
            multiplier *= 0.75
            reasons.append(f"moderately_overqualified({estimated_years:.0f}y)")
        elif min_years > 0 and estimated_years < min_years * 0.5:
            multiplier *= 0.6
            reasons.append(f"underqualified({estimated_years:.0f}y vs min {min_years}y)")

    # ── 3. Career Coherence / Domain Depth ───────────────────────────────────
    exp_keywords = _extract_domain_keywords(experience + " " + skills_text + " " + summary)
    domain_depth = len(exp_keywords & (jd_domain_keywords | domain_tokens | role_tokens))

    if domain_depth <= 1 and len(exp_keywords) > 5:
        multiplier *= 0.55
        reasons.append(f"low_domain_coherence(overlap={domain_depth})")
    elif domain_depth >= 8:
        multiplier *= 1.1
        reasons.append(f"deep_domain_expertise(overlap={domain_depth})")

    # ── 4. Seniority Tier Mismatch ───────────────────────────────────────────
    # Detect whether the candidate's TITLE tier is compatible with the JD's
    # seniority level. A "Head of Sales at JP Morgan" (tier 3) should NOT be
    # recommended for an IC / Mid-Level sales role (tier 1-2), and vice versa.
    if seniority_level and headline:
        cand_tier = _detect_seniority_tier(headline)
        jd_tier = _jd_seniority_to_tier(seniority_level)
        tier_gap = cand_tier - jd_tier  # positive = candidate is more senior

        if tier_gap >= 2:
            # Candidate is 2+ tiers above the JD (e.g., VP/Head for an IC role)
            # This is a fundamental career trajectory mismatch — heavy penalty
            multiplier *= 0.3
            tier_names = {1: "IC", 2: "Manager", 3: "Director/VP/Head", 4: "C-Suite"}
            reasons.append(
                f"seniority_tier_mismatch(candidate={tier_names.get(cand_tier, '?')}"
                f",jd={tier_names.get(jd_tier, '?')})"
            )
        elif tier_gap == 1:
            # Candidate is 1 tier above (e.g., Manager for an IC role)
            # Moderate penalty — could still be relevant in some cases
            multiplier *= 0.65
            tier_names = {1: "IC", 2: "Manager", 3: "Director/VP/Head", 4: "C-Suite"}
            reasons.append(
                f"seniority_tier_above(candidate={tier_names.get(cand_tier, '?')}"
                f",jd={tier_names.get(jd_tier, '?')})"
            )
        elif tier_gap <= -2:
            # Candidate is 2+ tiers below (e.g., IC for a C-Suite role)
            multiplier *= 0.4
            tier_names = {1: "IC", 2: "Manager", 3: "Director/VP/Head", 4: "C-Suite"}
            reasons.append(
                f"seniority_tier_below(candidate={tier_names.get(cand_tier, '?')}"
                f",jd={tier_names.get(jd_tier, '?')})"
            )

    return multiplier, " | ".join(reasons) if reasons else "neutral"


# ─────────────────────────────────────────────────────────────────────────────
# Core reranking logic
# ─────────────────────────────────────────────────────────────────────────────

def _rerank_sync(
    jd_text: str,
    candidates: list[dict],
    top_k: int,
    expansion: Optional[dict] = None,
    company_name: Optional[str] = None,
) -> list[dict]:
    """Synchronous reranking — called from a thread executor."""
    reranker = _get_reranker()
    if not candidates:
        return []

    # ── Step 0: Filter out existing employees ────────────────────────────────
    # _GENERIC_SUFFIXES is compiled once at module scope; this pattern was
    # previously written out inline and re-resolved on every candidate.
    if company_name:
        company_clean = _GENERIC_SUFFIXES.sub('', company_name.lower()).strip()
        if len(company_clean) >= 3:
            company_tokens = [company_clean] + [t.strip() for t in company_clean.split() if len(t.strip()) >= 4]
            filtered = []
            for c in candidates:
                cand_comp = (c.get("current_company") or "").lower()
                cand_comp_clean = _GENERIC_SUFFIXES.sub('', cand_comp).strip()

                is_match = False
                if len(cand_comp_clean) >= 3:
                    is_match = any(t in cand_comp_clean or cand_comp_clean in t for t in company_tokens)

                if is_match:
                    print(f"  [Stage3] Filtered {c.get('name')} (already at {c.get('current_company')})")
                    continue
                filtered.append(c)
            candidates = filtered

    if not candidates:
        return []

    # ── Step 1: Cross-encoder scoring ────────────────────────────────────────
    pairs = [(jd_text, _build_text_blob(c)) for c in candidates]
    scores = reranker.predict(pairs, batch_size=_RERANK_BATCH_SIZE, show_progress_bar=False)

    scored = [
        {**cand, "reranker_score": float(score)}
        for cand, score in zip(candidates, scores)
    ]

    # ── Step 2: Post-scoring adjustments ─────────────────────────────────────
    if expansion:
        jd_domain_kw = _extract_domain_keywords(jd_text)
        role_synonyms = expansion.get("role_synonyms", [])
        min_years = int(expansion.get("min_years_experience", 0))
        max_years = int(expansion.get("max_years_experience", 99))
        primary_domain = expansion.get("primary_domain", "")
        seniority_level = expansion.get("seniority_level", "")

        adjusted_count = 0
        for entry in scored:
            mult, reason = _compute_adjustments(
                entry, jd_domain_kw, role_synonyms,
                min_years, max_years, primary_domain, seniority_level,
            )
            if mult != 1.0:
                entry["reranker_score_raw"] = entry["reranker_score"]
                entry["reranker_score"] = entry["reranker_score"] * mult
                entry["adjustment_reason"] = reason
                adjusted_count += 1

        print(f"  [Stage3] Post-scoring: {adjusted_count}/{len(scored)} candidates adjusted")

    # ── Step 3: Sort and truncate ────────────────────────────────────────────
    scored.sort(key=lambda x: x["reranker_score"], reverse=True)
    top_candidates = scored[:top_k]

    # --- Debug dump of the reranked shortlist (opt-in) ---
    # This previously ran unconditionally on every /search request: a synchronous
    # write to a single fixed path, so concurrent requests raced and clobbered
    # each other's output, and a hardcoded developer path was baked into the
    # comment. Now gated behind RERANKER_DEBUG_DUMP=1.
    if os.getenv("RERANKER_DEBUG_DUMP") != "1":
        return top_candidates

    try:
        root_dir = pathlib.Path(__file__).resolve().parent.parent.parent
        output_path = root_dir / "semantic_top_results.txt"
        
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(f"Top {top_k} Candidates from Semantic Reranker\n")
            f.write("==================================================\n\n")
            for i, c in enumerate(top_candidates, 1):
                f.write(f"{i}. {c.get('name', 'Unknown')}\n")
                f.write(f"   Headline: {c.get('headline', '')}\n")
                f.write(f"   Company: {c.get('current_company', '')}\n")
                f.write(f"   Score: {c.get('reranker_score', 0):.4f}\n")
                f.write(f"   Reason: {c.get('adjustment_reason', 'neutral')}\n")
                f.write(f"   URL: {c.get('profile_url', '')}\n\n")
        print(f"  [Stage3] Dumped top results to {output_path}")
    except Exception as e:
        print(f"  [Stage3] Failed to dump results: {e}")
    # -----------------------------------------------------------

    return top_candidates


async def rerank(
    jd_text: str,
    candidates: list[dict],
    top_k: int,
    expansion: Optional[dict] = None,
    company_name: Optional[str] = None,
) -> list[dict]:
    """
    Stage 3 entry point (async wrapper over sync reranking).
    Returns top-K candidates sorted by adjusted reranker_score descending.

    Args:
        jd_text:    Original job description text
        candidates: List of candidate dicts from Stage 2
        top_k:      Number of candidates to return
        expansion:  Stage 1 ontology dict (used for post-scoring adjustments)
        company_name: Optional hiring company name to filter out existing employees
    """
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        _rerank_pool, _rerank_sync, jd_text, candidates, top_k, expansion, company_name
    )
    print(f"  [Stage3] Reranked {len(candidates)} → top-{len(result)}")
    return result
