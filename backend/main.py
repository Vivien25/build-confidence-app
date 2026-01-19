from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.chat import router as chat_router
from routers.users import router as users_router

app = FastAPI(title="Build Confidence API")

# =========================
# CORS (Frontend → Backend)
# =========================
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://build-confidence-app.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# Health check (optional)
# =========================
@app.get("/")
def health():
    return {"status": "ok", "service": "build-confidence-backend"}

# =========================
# Register routers
# =========================
app.include_router(chat_router)
app.include_router(users_router)
