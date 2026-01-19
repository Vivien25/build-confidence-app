from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

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
# GLOBAL OPTIONS HANDLER
# (Fixes 400 preflight issue)
# =========================
@app.options("/{path:path}")
async def options_handler(request: Request, path: str):
    return Response(status_code=200)

# =========================
# Health check
# =========================
@app.get("/")
def health():
    return {"status": "ok", "service": "build-confidence-backend"}

# =========================
# Register routers
# =========================
app.include_router(chat_router)
app.include_router(users_router)
