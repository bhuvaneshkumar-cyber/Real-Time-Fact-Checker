import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from loguru import logger
from openai import APIConnectionError, APIStatusError, APITimeoutError
from pydantic import BaseModel, Field

from app import checker
from app.config import config


class FactCheckRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    videoTitle: str | None = Field(None, max_length=300)


class FactCheckResult(BaseModel):
    claim: str
    verdict: str  # TRUE | FALSE | MISLEADING | UNVERIFIABLE
    explanation: str
    confidence: str  # HIGH | MEDIUM | LOW
    source: str | None = None


class FactCheckResponse(BaseModel):
    results: list[FactCheckResult]
    processingTimeMs: int


@asynccontextmanager
async def lifespan(app: FastAPI):
    warm = asyncio.create_task(checker.warm_up())
    yield
    warm.cancel()


# No CORS middleware: the extension reaches this API via host_permissions (which bypass CORS),
# and leaving it off stops arbitrary web pages from calling the local backend.
app = FastAPI(title="Real-Time Fact-Checker API", version="2.0.0", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "provider": config.LLM_PROVIDER, "model": checker.MODEL,
            "llm": await checker.llm_status(), "search": config.USE_SEARCH}


@app.post("/api/v1/fact-check", response_model=FactCheckResponse)
async def fact_check(req: FactCheckRequest):
    start = time.perf_counter()
    try:
        results = await checker.check(req.text, req.videoTitle)
    except APITimeoutError:
        raise HTTPException(504, f"The LLM took longer than {config.REQUEST_TIMEOUT}s.")
    except APIConnectionError:
        raise HTTPException(503, f"Cannot reach the LLM ({config.LLM_PROVIDER}). Is it running?")
    except APIStatusError as e:
        raise HTTPException(502, f"LLM error: {e.message}")
    ms = int((time.perf_counter() - start) * 1000)
    logger.info(f"{len(results)} claim(s) in {ms}ms from {len(req.text)} chars")
    return FactCheckResponse(results=results, processingTimeMs=ms)
