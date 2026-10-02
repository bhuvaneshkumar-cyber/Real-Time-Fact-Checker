from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager


from app.routers import fact_check
from app.config import config
from app.utils.logger import logger

# Modern Lifespan approach replaces @app.on_event("startup")
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up Real-Time Fact-Checker API...")
    # Because we migrated to Pydantic BaseSettings, configuration is already 
    # validated the moment `config` is imported. We just log success here.
    logger.info(f"Configuration loaded successfully. Using LLM Provider: {config.LLM_PROVIDER}")
    yield
    logger.info("Shutting down Real-Time Fact-Checker API...")

# Initialize FastAPI app
app = FastAPI(
    title="Real-Time Fact-Checker API",
    description="API for extracting and verifying factual claims from audio/text streams.",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS
origins = ["*"]

if config.EXTENSION_ID:
    # Explicitly define valid origins instead of relying on invalid port wildcards
    origins = [
        f"chrome-extension://{config.EXTENSION_ID}",
        "http://localhost:3000",
        "http://localhost:8001",
        "http://localhost:8080",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:8001",
        "http://127.0.0.1:8080",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(fact_check.router, prefix="/api/v1")

# Health check endpoint
@app.get("/health")
async def health_check():
    return {"status": "healthy", "version": "1.0.0"}

# Root endpoint
@app.get("/")
async def root():
    return {
        "message": "Welcome to the Real-Time Fact-Checker API",
        "docs": "/docs",
        "health": "/health"
    }