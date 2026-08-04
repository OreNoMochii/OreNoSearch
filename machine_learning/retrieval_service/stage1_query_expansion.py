"""
stage1_query_expansion.py — JD ontology expansion via direct LLM call.

Transforms raw JD text into a rich, structured query object:
  - required_skills / preferred_skills
  - role_synonyms / adjacent_roles
  - japanese_equivalents (for bilingual candidate pools)
  - min/max_years_experience
  - search_keywords  (union of all terms for Meilisearch)
  - primary_domain   (core professional domain, e.g. "Enterprise Sales")
  - seniority_level   (Junior / Mid-Level / Senior / Executive)

Uses the direct OpenAI-compatible client (llm_client.py) instead of
DSPy to avoid base_url routing issues with dspy-ai 2.4.9.
"""
import json
import re
from typing import Optional
from llm_client import chat


_SYSTEM_PROMPT = """\
You are a technical recruiter assistant.
Given a job description, extract a structured ontology for candidate retrieval.
Focus on substance. Be comprehensive about skill synonyms.
For Japanese roles, always include both English and Japanese equivalents.
Return ONLY a valid JSON object — no prose, no markdown fences.
Schema:
{
  "required_skills": ["list of strings"],
  "preferred_skills": ["list of strings"],
  "role_synonyms": ["list of strings — exact job title synonyms for this role"],
  "adjacent_roles": ["list of strings — related but different roles"],
  "japanese_equivalents": ["list of Japanese strings"],
  "primary_domain": "the core professional domain, e.g. 'Enterprise Sales', 'Cloud Infrastructure', 'Backend Engineering', 'Product Management'",
  "seniority_level": "one of: Junior, Mid-Level, Senior, Executive",
  "min_years_experience": "integer (minimum years required)",
  "max_years_experience": "integer (infer a realistic upper bound based on the role's seniority, e.g. 5 for Junior, 8 for Mid-Level, 15 for Senior. Do NOT default to 99 unless it is a C-level executive role)",
  "search_keywords": ["combined list for lexical search"]
}
"""


def _fallback_expansion(jd_text: str) -> dict:
    """Minimal fallback if LLM fails — extract words from JD."""
    words = re.findall(r'\b[A-Za-z\u3000-\u9fff]{3,}\b', jd_text)
    keywords = list(dict.fromkeys(words))[:30]
    return {
        "required_skills": keywords[:15],
        "preferred_skills": [],
        "role_synonyms": [],
        "adjacent_roles": [],
        "japanese_equivalents": [],
        "primary_domain": "",
        "seniority_level": "Mid-Level",
        "min_years_experience": 0,
        "max_years_experience": 99,
        "search_keywords": keywords,
    }


async def expand_jd(jd_text: str, model: Optional[str] = None) -> dict:
    """
    Expand a JD into a rich ontology dict.
    Returns dict with keys: required_skills, preferred_skills,
    role_synonyms, adjacent_roles, japanese_equivalents,
    primary_domain, seniority_level,
    min_years_experience, max_years_experience, search_keywords.
    """
    import asyncio

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": f"Job Description:\n{jd_text}"},
    ]

    loop = asyncio.get_event_loop()
    raw = await loop.run_in_executor(None, lambda: chat(messages, model=model, max_tokens=1024))

    # Strip markdown fences if present
    raw = re.sub(r"```(?:json)?\n?([\s\S]*?)```", r"\1", raw).strip()

    try:
        expansion = json.loads(raw)
    except json.JSONDecodeError:
        print(f"  [Stage1] JSON parse failed, using fallback. Raw: {raw[:200]}")
        return _fallback_expansion(jd_text)

    # Ensure all expected keys exist with defaults
    defaults = {
        "required_skills": [],
        "preferred_skills": [],
        "role_synonyms": [],
        "adjacent_roles": [],
        "japanese_equivalents": [],
        "primary_domain": "",
        "seniority_level": "Mid-Level",
        "min_years_experience": 0,
        "max_years_experience": 99,
        "search_keywords": [],
    }
    defaults.update(expansion)

    # Auto-build search_keywords if empty
    if not defaults["search_keywords"]:
        defaults["search_keywords"] = list(dict.fromkeys(
            defaults["required_skills"] +
            defaults["role_synonyms"] +
            defaults["adjacent_roles"] +
            defaults["japanese_equivalents"]
        ))[:40]

    print(f"  → domain: {defaults['primary_domain']} | seniority: {defaults['seniority_level']} | exp: {defaults['min_years_experience']}-{defaults['max_years_experience']}y")
    return defaults
