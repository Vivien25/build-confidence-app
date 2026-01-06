from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import auth, chat, progress

app = FastAPI(title="Build Confidence API")

# Allow local dev origins (frontend at localhost:5173 by default)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(chat.router)
app.include_router(progress.router)

@app.get("/")
def healthcheck():
    return {"status": "ok"}
