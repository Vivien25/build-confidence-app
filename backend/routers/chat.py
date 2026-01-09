import os
import json
import re
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from google import genai
from google.genai import types

router = APIRouter(prefix="/chat", tags=["chat"])

API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if not API_KEY:
    raise RuntimeError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) in backend/.env")

# Set in backend/.env:
# GEMINI_MODEL=gemini-3-flash-preview
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

client = genai.Client(api_key=API_KEY)

# ---------------------------
# Tiny JSON-file state store
# ---------------------------
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
STATE_FILE = DATA_DIR / "user_state.json"

def _load_state() -> Dict[str, Any]:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

def _save_state(state: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")

def touch_user(user_id: str) -> None:
    state = _load_state()
    st = state.get(user_id, {})
    st["last_user_activity"] = datetime.now(timezone.utc).isoformat()
    state[user_id] = st
    _save_state(state)

def set_current_plan(user_id: str, plan: List[str]) -> None:
    state = _load_state()
    st = state.get(user_id, {})
    st["current_plan"] = plan
    st["last_plan_set_at"] = datetime.now(timezone.utc).isoformat()
    state[user_id] = st
    _save_state(state)

def get_user_state(user_id: str) -> Dict[str, Any]:
    return _load_state().get(user_id, {})

def parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


# ---------------------------
# Schemas
# ---------------------------
class ChatIn(BaseModel):
    user_id: str = "local-dev"
    focus: str = "work"
    message: str

class ChatOut(BaseModel):
    mode: str                 # "chat" | "coach"
    message: str              # friend-like
    tips: List[str] = []
    plan: List[str] = []
    question: str = ""

class CheckInIn(BaseModel):
    user_id: str = "local-dev"
    focus: str = "work"
    # how long of inactivity before we generate a nudge
    inactive_hours: int = 18

class CheckInOut(BaseModel):
    should_send: bool
    message: str


def extract_json_object(s: str) -> Optional[dict]:
    """Extract first JSON object from mixed text."""
    if not s:
        return None
    m = re.search(r"\{.*\}", s, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


# ---------------------------
# Main chat endpoint
# ---------------------------
@router.post("", response_model=ChatOut)
def chat(payload: ChatIn):
    user_msg = (payload.message or "").strip()
    if not user_msg:
        raise HTTPException(status_code=400, detail="message is required")

    # record activity whenever user sends a message
    touch_user(payload.user_id)

    system = (
        "You are a supportive, friend-like confidence coach.\n"
        "Return ONLY raw JSON (no markdown, no backticks, no extra text).\n"
        "JSON keys:\n"
        "- mode: 'chat' or 'coach'\n"
        "- message: natural reply like a real friend (required)\n"
        "- tips: optional array (0-3) short actionable tips\n"
        "- plan: optional array (0-5) clear steps the user can follow\n"
        "- question: optional string (keep empty unless truly needed)\n"
        "\n"
        "Rules:\n"
        "- Default mode='chat'.\n"
        "- Use mode='coach' only when the user asks for steps/plan or seems stuck.\n"
        "- In mode='chat', usually set question=''.\n"
        "- If you include plan, steps must be short and executable.\n"
        "- Don't force tips/plan/question every time.\n"
    )

    prompt = {
        "focus": payload.focus,
        "user_message": user_msg,
    }

    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[system + "\n\n" + json.dumps(prompt, ensure_ascii=False)],
            config=types.GenerateContentConfig(
                temperature=0.7,
                response_mime_type="application/json",
            ),
        )

        raw = resp.text or ""
        try:
            data = json.loads(raw)
        except Exception:
            data = extract_json_object(raw)

        if not data:
            print("❌ Gemini returned non-JSON:\n", raw[:2000])
            raise HTTPException(status_code=500, detail="Gemini did not return valid JSON. Check logs.")

        mode = str(data.get("mode", "chat")).strip().lower()
        message = str(data.get("message", "")).strip()
        question = str(data.get("question", "")).strip()

        tips = data.get("tips", [])
        plan = data.get("plan", [])

        if mode not in ("chat", "coach"):
            mode = "chat"

        if not message:
            print("❌ Missing message field:", data)
            raise HTTPException(status_code=500, detail="Gemini returned invalid JSON: missing message.")

        tips_clean: List[str] = []
        if isinstance(tips, list):
            for t in tips:
                s = str(t).strip()
                if s:
                    tips_clean.append(s)
        tips_clean = tips_clean[:3]

        plan_clean: List[str] = []
        if isinstance(plan, list):
            for p in plan:
                s = str(p).strip()
                if s:
                    plan_clean.append(s)
        plan_clean = plan_clean[:5]

        # Persist plan if model provided one
        if plan_clean:
            set_current_plan(payload.user_id, plan_clean)

        return {
            "mode": mode,
            "message": message,
            "tips": tips_clean,
            "plan": plan_clean,
            "question": question,
        }

    except HTTPException:
        raise
    except Exception as e:
        print("❌ Gemini error:", repr(e))
        raise HTTPException(status_code=500, detail=f"Gemini error: {str(e)}")


# ---------------------------
# Daily check-in endpoint
# ---------------------------
@router.post("/checkin", response_model=CheckInOut)
def checkin(payload: CheckInIn):
    st = get_user_state(payload.user_id)
    last = parse_dt(st.get("last_user_activity"))
    plan = st.get("current_plan", [])

    # If never active, don't nudge
    if not last:
        return {"should_send": False, "message": ""}

    inactive_for = datetime.now(timezone.utc) - last
    threshold = timedelta(hours=max(1, int(payload.inactive_hours)))

    if inactive_for < threshold:
        return {"should_send": False, "message": ""}

    # Generate a short friendly check-in.
    # IMPORTANT: this endpoint returns plain text (not JSON schema),
    # so your UI can simply insert it as an assistant message.
    system = (
        "You are a supportive friend-like coach.\n"
        "Write ONE short check-in message.\n"
        "If a plan exists, ask about progress on it (no headings).\n"
        "Keep it under 2 sentences.\n"
        "Be warm, non-judgmental, and easy to reply to.\n"
    )

    prompt = {
        "focus": payload.focus,
        "inactive_hours": int(inactive_for.total_seconds() // 3600),
        "current_plan": plan,
    }

    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[system + "\n\n" + json.dumps(prompt, ensure_ascii=False)],
            config=types.GenerateContentConfig(temperature=0.6),
        )
        msg = (resp.text or "").strip()

        # Guard: if model returns nothing, still be safe
        if not msg:
            msg = "Hey — quick check-in. How did today go with your plan?"

        return {"should_send": True, "message": msg}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini check-in error: {str(e)}")
