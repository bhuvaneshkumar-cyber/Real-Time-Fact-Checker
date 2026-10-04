"""Extract and judge claims in ONE LLM call; optionally re-judge them against web search results."""
import asyncio
import json
import re
import time

from ddgs import DDGS
from loguru import logger
from openai import AsyncOpenAI

from app.config import config

VERDICTS = ["TRUE", "FALSE", "MISLEADING", "UNVERIFIABLE"]
CONFIDENCE = ["HIGH", "MEDIUM", "LOW"]
MAX_CLAIMS = 3  # bounds output tokens, which dominate latency on CPU
COMMON = set("that this with from they them their there were have been about which would could what when "
             "where into than then also just like more most some over only very really know think because".split())

SCHEMA = {
    "type": "object",
    "properties": {
        "claims": {
            "type": "array",
            "maxItems": MAX_CLAIMS,
            "items": {
                "type": "object",
                # explanation before verdict: the model reasons first, then commits
                "properties": {
                    "claim": {"type": "string", "maxLength": 200},
                    "explanation": {"type": "string", "maxLength": 240},
                    "verdict": {"type": "string", "enum": VERDICTS},
                    "confidence": {"type": "string", "enum": CONFIDENCE},
                },
                "required": ["claim", "explanation", "verdict", "confidence"],
            },
        }
    },
    "required": ["claims"],
}

REPLY_FORMAT = (
    'Reply with JSON only: {"claims": [{"claim": "...", "explanation": "...", '
    '"verdict": "TRUE|FALSE|MISLEADING|UNVERIFIABLE", "confidence": "HIGH|MEDIUM|LOW"}]}'
)

SYSTEM = f"""You fact-check live video transcripts.
1. Find at most {MAX_CLAIMS} checkable factual claims in TRANSCRIPT: numbers, dates, names, events, science, history, geography. Skip opinions, jokes, questions, predictions, ads and small talk.
2. Rewrite each claim as one short self-contained sentence (resolve "he", "it", "this" using CONTEXT).
3. Judge each claim: TRUE, FALSE, MISLEADING (partly true or missing key context) or UNVERIFIABLE (too recent, obscure or personal to confirm).
4. explanation: one sentence, at most 20 words, stating the correct fact.
{REPLY_FORMAT}
If nothing is checkable reply {{"claims": []}}"""

VERIFY = f"""You verify claims using web search results.
For each numbered CLAIM, judge it from its SOURCES (use your own knowledge only if they say nothing relevant): TRUE, FALSE, MISLEADING (partly true or missing key context) or UNVERIFIABLE.
Keep the claims in the same order. explanation: one sentence, at most 20 words.
{REPLY_FORMAT}"""

if config.LLM_PROVIDER == "ollama":
    client = AsyncOpenAI(base_url=config.OLLAMA_BASE_URL, api_key="ollama",
                         timeout=config.REQUEST_TIMEOUT, max_retries=0)
    MODEL = config.OLLAMA_MODEL
    # Grammar-constrained JSON (never unparseable); keep the model loaded between requests.
    EXTRA = {
        "response_format": {"type": "json_schema", "json_schema": {"name": "fact_check", "schema": SCHEMA}},
        "extra_body": {"keep_alive": config.OLLAMA_KEEP_ALIVE},
    }
else:
    client = AsyncOpenAI(base_url=config.NIM_BASE_URL, api_key=config.NIM_API_KEY,
                         timeout=config.REQUEST_TIMEOUT, max_retries=1)
    MODEL = config.NIM_MODEL
    EXTRA = {}  # prompt-only; _parse() digs the JSON out of the reply


def _parse(content: str) -> list[dict]:
    """Pull the claims out of a model reply, tolerating prose or code fences around the JSON."""
    try:
        claims = json.loads(content[content.find("{"):content.rfind("}") + 1])["claims"]
    except (ValueError, KeyError, TypeError):
        logger.warning(f"Unparseable LLM reply: {content[:200]!r}")
        return []
    if not isinstance(claims, list):
        return []
    results = []
    for c in claims[:MAX_CLAIMS]:
        if not isinstance(c, dict) or not str(c.get("claim", "")).strip():
            continue
        verdict = str(c.get("verdict", "")).strip().upper()
        confidence = str(c.get("confidence", "")).strip().upper()
        results.append({
            "claim": str(c["claim"]).strip(),
            "verdict": verdict if verdict in VERDICTS else "UNVERIFIABLE",
            "explanation": str(c.get("explanation", "")).strip(),
            "confidence": confidence if confidence in CONFIDENCE else "LOW",
            "source": None,
        })
    return results


async def _ask(system: str, user: str) -> list[dict]:
    resp = await client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0,
        max_tokens=config.LLM_MAX_TOKENS,
        **EXTRA,
    )
    content = resp.choices[0].message.content or ""
    logger.debug(f"LLM reply: {content}")
    return _parse(content)


def _search(query: str) -> list[dict]:
    try:
        return DDGS().text(query, max_results=config.SEARCH_MAX_RESULTS)
    except Exception as e:
        logger.warning(f"Search failed for {query!r}: {e}")
        return []


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if (len(w) > 3 or w.isdigit()) and w not in COMMON}


async def check(text: str, title: str | None = None) -> list[dict]:
    # CONTEXT is only the title, never earlier transcript: a 3B model mines claims out of earlier text
    # (re-checking old claims, +5-10 s per chunk). The title is enough to resolve "he"/"it" to the topic.
    user = f'CONTEXT: video titled "{title}"\nTRANSCRIPT: {text}' if title else f"TRANSCRIPT: {text}"
    # Keep only claims grounded in what was said (not invented, not mined from the title).
    # ponytail: word-overlap heuristic; add a quote field to the schema if ungrounded claims still slip through.
    spoken = _words(text)
    results = [r for r in await _ask(SYSTEM, user) if _words(r["claim"]) & spoken]
    if not (config.USE_SEARCH and results):
        return results

    hits = await asyncio.gather(*(asyncio.to_thread(_search, r["claim"]) for r in results))
    evidence = "\n\n".join(
        f"CLAIM {i}: {r['claim']}\nSOURCES:\n"
        + ("\n".join(f"- {h['title']}: {h['body'][:300]}" for h in hs) or "- none")
        for i, (r, hs) in enumerate(zip(results, hits), 1)
    )
    verified = await _ask(VERIFY, evidence)
    if len(verified) != len(results):  # model merged/dropped claims: keep the knowledge-only verdicts
        verified = results
    for r, v, hs in zip(results, verified, hits):
        r.update(verdict=v["verdict"], explanation=v["explanation"], confidence=v["confidence"],
                 source=hs[0]["href"] if hs else None)
    return results


async def warm_up() -> None:
    """Load the model and cache the system prompt at startup so the first real check is fast."""
    start = time.perf_counter()
    try:
        await _ask(SYSTEM, "TRANSCRIPT: hello everyone")
        logger.info(f"LLM {MODEL} ready ({time.perf_counter() - start:.1f}s warm-up)")
    except Exception as e:
        logger.warning(f"LLM warm-up failed ({MODEL}): {e}")


async def llm_status() -> str:
    """'ok', 'model-missing' (server up, model not pulled) or 'down'."""
    try:
        page = await client.with_options(timeout=3).models.list()
    except Exception:
        return "down"
    ids = {m.id for m in page.data}
    return "ok" if MODEL in ids or f"{MODEL}:latest" in ids else "model-missing"


if __name__ == "__main__":  # parser self-check: python -m app.checker
    assert _parse('```json\n{"claims": [{"claim": "Water boils at 50C", "verdict": "false", '
                  '"explanation": "It boils at 100C.", "confidence": "high"}]}\n```') == [
        {"claim": "Water boils at 50C", "verdict": "FALSE", "explanation": "It boils at 100C.",
         "confidence": "HIGH", "source": None}]
    assert _parse('{"claims": [{"claim": "x", "verdict": "LACKS CONTEXT"}]}')[0]["verdict"] == "UNVERIFIABLE"
    assert _parse('{"claims": [{"claim": "  "}, "junk"]}') == []
    assert _parse("Sure! Here are the claims:") == []
    assert _parse('{"claims": {"claim": "not a list"}}') == []
    spoken = _words("and he was born in 1879 in germany and later won the nobel prize")
    assert _words("Albert Einstein was born in 1879 in Germany.") & spoken  # grounded in what was said: kept
    assert not _words("The Great Wall of China is visible from the Moon.") & spoken  # not in the transcript: dropped
    print("ok")
