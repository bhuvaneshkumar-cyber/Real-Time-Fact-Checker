from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional
from pydantic import model_validator

class Config(BaseSettings):
    """Application configuration validated by Pydantic."""

    # Server settings are handled by Uvicorn CLI and environment variables natively.

    # LLM provider selection: ollama, or nim
    LLM_PROVIDER: str = "ollama"

    # Ollama settings
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5:3b"
    OLLAMA_KEEP_ALIVE: str = "30m"  # Keep model loaded in VRAM (avoids cold-start)
    OLLAMA_NUM_CTX: int = 2048      # Smaller context window = faster inference
 
    # NVIDIA NIM settings
    NIM_API_KEY: Optional[str] = None
    NIM_MODEL: str = "nemotron-3-8b-chat"
    NIM_BASE_URL: str = "https://integrate.api.nvidia.com/v1"

    # Search API settings (Tavily)
    TAVILY_API_KEY: Optional[str] = None
    TAVILY_MAX_RESULTS: int = 5
    TAVILY_SEARCH_DEPTH: str = "advanced"

    # Enable/disable search functionality
    USE_SEARCH: bool = True

    # Extension settings
    EXTENSION_ID: Optional[str] = None

    # Request settings
    REQUEST_TIMEOUT: int = 30  # seconds

    # LLM performance tuning
    LLM_MAX_CONCURRENCY: int = 2       # Max parallel LLM calls (prevents GPU saturation)
    LLM_EXTRACT_MAX_TOKENS: int = 512  # Token limit for claim extraction
    LLM_CLASSIFY_MAX_TOKENS: int = 150 # Token limit for verdict (short responses)

    # Load from .env file automatically
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @model_validator(mode='after')
    def validate_dependencies(self) -> 'Config':
        """Validate that required configuration is present based on logic."""
        provider = self.LLM_PROVIDER.lower()
        
        if provider == "ollama":
            if not self.OLLAMA_MODEL:
                raise ValueError("OLLAMA_MODEL must be set when LLM_PROVIDER is 'ollama'.")
        elif provider == "nim":
            if not self.NIM_API_KEY:
                raise ValueError("NIM_API_KEY must be set when LLM_PROVIDER is 'nim'.")
        else:
            raise ValueError(f"Unsupported LLM_PROVIDER: {provider}. Choose 'ollama', or 'nim'.")

        # DuckDuckGo search doesn't require an API key
        pass

        return self

# Create a singleton instance
# Pydantic will read the .env file and validate everything immediately here
config = Config()