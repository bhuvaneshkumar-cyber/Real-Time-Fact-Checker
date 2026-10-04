from typing import Literal, Optional

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    """Application configuration, read from the environment / backend/.env."""

    LLM_PROVIDER: Literal["ollama", "nim"] = "ollama"

    # Ollama (local). Model picked by benchmark_models.py on a CPU-only laptop.
    OLLAMA_BASE_URL: str = "http://localhost:11434/v1"
    OLLAMA_MODEL: str = "llama3.2:3b"
    OLLAMA_KEEP_ALIVE: str = "30m"  # keep the model in RAM between requests (no cold starts)

    # NVIDIA NIM (hosted, OpenAI-compatible)
    NIM_API_KEY: Optional[str] = None
    NIM_MODEL: str = "meta/llama-3.1-8b-instruct"
    NIM_BASE_URL: str = "https://integrate.api.nvidia.com/v1"

    # Ground verdicts in DuckDuckGo results: more accurate, adds one search + one LLM call.
    USE_SEARCH: bool = False
    SEARCH_MAX_RESULTS: int = 3

    REQUEST_TIMEOUT: int = 60  # seconds per LLM call
    LLM_MAX_TOKENS: int = 400

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @model_validator(mode="after")
    def _require_nim_key(self) -> "Config":
        if self.LLM_PROVIDER == "nim" and not self.NIM_API_KEY:
            raise ValueError("NIM_API_KEY must be set when LLM_PROVIDER is 'nim'.")
        return self


config = Config()
