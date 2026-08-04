"""
llm_client.py — Thin OpenAI-compatible LLM client.

Bypasses DSPy's broken base_url routing in v2.4.9.
Calls NVIDIA NIM (or any OpenAI-compatible endpoint) directly
using the openai SDK v1+.
"""
import openai
from typing import Optional, Dict, List
from config import LLM_API_KEY, LLM_API_BASE, LLM_MODEL

_client: Optional[openai.OpenAI] = None


def get_client() -> openai.OpenAI:
    global _client
    if _client is None:
        _client = openai.OpenAI(
            api_key=LLM_API_KEY,
            base_url=LLM_API_BASE,
        )
    return _client


def chat(
    messages: List[Dict],
    model: Optional[str] = None,
    max_tokens: int = 2048,
    temperature: float = 0.0,
    response_format: Optional[Dict] = None,
) -> str:
    """
    Send a chat completion request. Returns the content string.
    Raises on API error (caller can catch and handle).
    """
    client = get_client()
    actual_model = model or LLM_MODEL
    if actual_model.startswith("nvidia:"):
        actual_model = actual_model.replace("nvidia:", "")

    kwargs: dict = dict(
        model=actual_model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    if response_format:
        kwargs["response_format"] = response_format

    if "gpt-oss-120" in actual_model.lower() or "deepseek-v4" in actual_model.lower():
        kwargs["max_tokens"] = max(max_tokens, 16384)
        original_model = model or LLM_MODEL
        if original_model.startswith("nvidia:") and "deepseek-v4" in actual_model.lower():
            kwargs["reasoning_effort"] = "max"
        else:
            kwargs["reasoning_effort"] = "high"

    resp = client.chat.completions.create(**kwargs)
    return resp.choices[0].message.content or ""
