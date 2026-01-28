from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


# ✅ Explicit imports for Docker

from backend.routers.chat import router as chat_router
from backend.routers.users import router as users_router

app = FastAPI(title="Better Me API")

# =========================
# CORS (Frontend → Backend)
# =========================
# Add your production frontend domain(s) here.
# IMPORTANT: Do NOT add a global OPTIONS route; CORSMiddleware handles preflight.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://build-better-me.vercel.app",
        "https://build-confidence-app.vercel.app",  # optional old domain
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# Health check
# =========================
@app.get("/")
def health():
    return {"status": "ok", "service": "better-me-backend"}

# =========================
# Register routers
# =========================
app.include_router(chat_router)
app.include_router(users_router)
