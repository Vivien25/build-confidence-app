import os
import json
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from google import genai
from google.genai import types

router = APIRouter(prefix="/chat", tags=["chat"])

API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if not API_KEY:
    raise RuntimeError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) in backend/.env")

# ✅ Set this in backend/.env (recommended)
# GEMINI_MODEL=gemini-3-flash-preview
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

client = genai.Client(api_key=API_KEY)


class ChatIn(BaseModel):
    user_id: str = "local-dev"
    focus: str = "work"
    message: str


class ChatOut(BaseModel):
    # "chat" = friend-like reply (default)
    # "coach" = structured coaching mode (only when helpful)
    mode: str
    message: str
    tips: List[str] = []
    question: str = ""


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


@router.post("", response_model=ChatOut)
def chat(payload: ChatIn):
    user_msg = (payload.message or "").strip()
    if not user_msg:
        raise HTTPException(status_code=400, detail="message is required")

    system = (
        "You are a supportive, friend-like coach for building confidence.\n"
        "Return ONLY raw JSON (no markdown, no backticks, no extra text).\n"
        "JSON keys:\n"
        "- mode: 'chat' or 'coach'\n"
        "- message: natural reply like a real friend (required)\n"
        "- tips: optional array (0-3) short actionable tips\n"
        "- question: optional short follow-up question (string)\n"
        "\n"
        "Rules:\n"
        "- Default to mode='chat'.\n"
        "- Use mode='coach' only when the user asks for a plan/steps, is stuck, or needs structure.\n"
        "- Don't force tips/question every time.\n"
        "\n"
        "Example:\n"
        "{\"mode\":\"chat\",\"message\":\"Hey — totally normal to feel that way...\",\"tips\":[],\"question\":\"\"}\n"
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
        tips = data.get("tips", [])
        question = str(data.get("question", "")).strip()

        if mode not in ("chat", "coach"):
            mode = "chat"

        if not message:
            print("❌ Missing message field:", data)
            raise HTTPException(status_code=500, detail="Gemini returned invalid JSON: missing message.")

        if not isinstance(tips, list):
            tips = []

        # sanitize tips
        tips_clean = []
        for t in tips:
            s = str(t).strip()
            if s:
                tips_clean.append(s)
        tips_clean = tips_clean[:3]

        return {
            "mode": mode,
            "message": message,
            "tips": tips_clean,
            "question": question,
        }

    except HTTPException:
        raise
    except Exception as e:
        print("❌ Gemini error:", repr(e))
        raise HTTPException(status_code=500, detail=f"Gemini error: {str(e)}")
