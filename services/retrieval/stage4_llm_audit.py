"""
stage4_llm_audit.py — Deterministic LLM audit of reranked candidates.

Takes top-K candidates from Stage 3 and audits each against the JD.
Uses the direct OpenAI-compatible client instead of DSPy to avoid
base_url routing issues with dspy-ai 2.4.9.

Key properties:
  - temperature=0 — deterministic, no scoring drift
  - Concurrent execution (LLM_CONCURRENCY parallel calls)
  - Structured JSON output with strict schema validation
  - Only PASS candidates returned to TypeScript backend
"""
import asyncio
import json
import re
from typing import Optional, List
from llm_client import chat
from config import LLM_CONCURRENCY


_SYSTEM_PROMPT = """\
You are a senior talent consultant. Evaluate the candidate against the job description.

EVALUATION RULES:
- A 1.5-2 year tenure is standard in modern tech — do NOT penalize it.
- Only REJECT for job hopping if there are MULTIPLE consecutive stints < 12 months.
- Overqualified means >= 2x the JD's required experience AND a clear seniority mismatch.
- If data is missing, score conservatively but do NOT fabricate evidence.
- evidence must be verbatim quotes from the candidate profile, not paraphrased.

Return ONLY a valid JSON object matching this exact schema (no prose, no markdown):
{
  "verdict": "PASS" or "FAIL",
  "fit_score": <integer 1-5, where 5 = excellent match>,
  "seniority_summary": "<candidate's total experience and seniority level>",
  "knockout_criteria_passed": <true or false>,
  "evidence": ["<verbatim quote 1>", "<verbatim quote 2>", "<verbatim quote 3>"],
  "rejection_reason": "<empty string if PASS, brief reason if FAIL>"
}

Only return PASS if fit_score >= 3 AND all hard knockout criteria are met.
"""


async def _audit_one(
    jd_text: str,
    candidate: dict,
    sem: asyncio.Semaphore,
    model: Optional[str] = None,
) -> Optional[dict]:
    """
    Audit a single candidate. Returns enriched dict on PASS, None on FAIL/error.
    """
    name = candidate.get("name", "Unknown")

    profile_str = json.dumps({
        k: candidate.get(k, "")
        for k in ["name", "headline", "current_company", "location",
                  "summary", "experience", "education", "skills"]
    }, ensure_ascii=False)

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": (
            f"Job Description:\n{jd_text}\n\n"
            f"Candidate Profile:\n{profile_str}"
        )},
    ]

    async with sem:
        try:
            loop = asyncio.get_event_loop()
            raw = await loop.run_in_executor(
                None, lambda: chat(messages, model=model, max_tokens=1024)
            )

            # Strip markdown fences if present
            raw = re.sub(r"```(?:json)?\n?([\s\S]*?)```", r"\1", raw).strip()

            result = json.loads(raw)

            verdict = str(result.get("verdict", "FAIL")).upper()
            fit_score = int(result.get("fit_score", 0))

            if verdict == "PASS" and fit_score >= 3:
                print(f"  [Stage4] ✅ PASS  ({fit_score}/5): {name}")
                return {
                    **candidate,
                    "audit_verdict": "PASS",
                    "audit_fit_score": fit_score,
                    "audit_seniority": result.get("seniority_summary", ""),
                    "audit_evidence": result.get("evidence", []),
                }
            else:
                reason = result.get("rejection_reason", "")
                print(f"  [Stage4] ❌ FAIL  ({fit_score}/5): {name} — {reason}")
                return None

        except json.JSONDecodeError as e:
            print(f"  [Stage4] ⚠️  JSON parse error for {name}: {e} | raw: {raw[:200]}")
            return None
        except Exception as exc:
            print(f"  [Stage4] ⚠️  ERROR for {name}: {exc}")
            return None


async def llm_audit(jd_text: str, candidates: List[dict], model: Optional[str] = None) -> List[dict]:
    """
    Stage 4 entry point.
    Audits all candidates concurrently (up to LLM_CONCURRENCY parallel calls).
    Returns only PASS candidates in the original reranked order.
    """
    sem = asyncio.Semaphore(LLM_CONCURRENCY)

    tasks = [_audit_one(jd_text, cand, sem, model) for cand in candidates]
    results = await asyncio.gather(*tasks, return_exceptions=False)

    passed = [r for r in results if r is not None]
    print(f"  [Stage4] {len(passed)} / {len(candidates)} candidates passed LLM audit.")
    return passed
