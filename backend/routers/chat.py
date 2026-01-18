import os
import json
import re
from typing import List, Optional, Dict, Any, Union, Tuple
from datetime import datetime, timezone, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from google import genai
from google.genai import types

router = APIRouter(prefix="/chat", tags=["chat"])

API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if not API_KEY:
    raise RuntimeError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) in backend/.env")

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
    STATE_FILE.write_text(
        json.dumps(state, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def get_user_state(user_id: str) -> Dict[str, Any]:
    return _load_state().get(user_id, {})


def _get_focus_conf_state(st: Dict[str, Any], focus: str) -> Dict[str, Any]:
    conf = st.get("confidence", {})
    if not isinstance(conf, dict):
        conf = {}
    f = conf.get(focus, {})
    if not isinstance(f, dict):
        f = {}
    return f


def _set_focus_conf_state(user_id: str, focus: str, patch: Dict[str, Any]) -> None:
    state = _load_state()
    st = state.get(user_id, {})
    conf = st.get("confidence", {})
    if not isinstance(conf, dict):
        conf = {}
    f = conf.get(focus, {})
    if not isinstance(f, dict):
        f = {}
    f.update(patch)
    conf[focus] = f
    st["confidence"] = conf
    state[user_id] = st
    _save_state(state)


def touch_user(user_id: str) -> None:
    state = _load_state()
    st = state.get(user_id, {})
    st["last_user_activity"] = datetime.now(timezone.utc).isoformat()
    state[user_id] = st
    _save_state(state)


def set_current_plan(user_id: str, plan: List[Any]) -> None:
    """
    Persist the current plan.
    Plan can be:
      - List[str]
      - List[{"label": str, "resources": [...]}, ...]
    """
    state = _load_state()
    st = state.get(user_id, {})
    st["current_plan"] = plan
    st["last_plan_set_at"] = datetime.now(timezone.utc).isoformat()
    state[user_id] = st
    _save_state(state)


def touch_checkin(user_id: str, focus: str) -> None:
    state = _load_state()
    st = state.get(user_id, {})
    st["last_checkin_at"] = datetime.now(timezone.utc).isoformat()
    st["last_checkin_focus"] = focus
    state[user_id] = st
    _save_state(state)


def parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def should_check_in(last_activity_iso: Optional[str], hours: int) -> bool:
    if not last_activity_iso:
        return True
    try:
        last = parse_dt(last_activity_iso)
        if not last:
            return True
        return datetime.now(timezone.utc) - last > timedelta(hours=hours)
    except Exception:
        return True


def extract_json_object(s: str) -> Optional[dict]:
    if not s:
        return None
    m = re.search(r"\{.*\}", s, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def is_returning(msg: str) -> bool:
    if not msg:
        return False

    m = msg.lower().strip()
    patterns = [
        r"\bhi\b",
        r"\bhello\b",
        r"\bhey\b",
        r"\bi'?m back\b",
        r"\bback again\b",
        r"\bhere again\b",
        r"\bchecking in\b",
        r"\bi'?m here\b",
        r"\blet'?s continue\b",
        r"\bit'?s me\b",
    ]
    return any(re.search(p, m) for p in patterns)


def looks_like_progress(msg: str) -> bool:
    if not msg:
        return False
    m = msg.lower().strip()
    return bool(
        re.search(
            r"(completed|complete|finished|done|made progress|improved|i did it|i followed|i did the plan|i completed my plan)",
            m,
        )
    )


def _history_to_contents(history: Optional[List[Dict[str, str]]], limit: int = 15) -> List[types.Content]:
    if not history:
        return []

    cleaned: List[Dict[str, str]] = []
    for h in history:
        if not isinstance(h, dict):
            continue
        role = (h.get("role") or "").strip().lower()
        content = (h.get("content") or "").strip()
        if not content:
            continue
        if role not in ("user", "assistant"):
            continue
        cleaned.append({"role": role, "content": content})

    cleaned = cleaned[-max(1, int(limit)) :]

    contents: List[types.Content] = []
    for h in cleaned:
        role = "user" if h["role"] == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part(text=h["content"])]))
    return contents


# ---------------------------
# Confidence parsing (backend)
# ---------------------------
def _parse_confidence_from_message(msg: str) -> Optional[float]:
    """
    Accept:
      - "6"
      - "6/10"
      - "confidence is 6"
      - "my confidence level is 6/10"
    Return 1..10 float, else None.
    """
    if not msg:
        return None
    m = msg.strip()

    # pure number
    if re.fullmatch(r"(10|[1-9])(\.\d+)?", m):
        v = float(m)
        return v if 1 <= v <= 10 else None

    # contains "/10"
    m2 = re.search(r"\b(10|[1-9])(\.\d+)?\s*/\s*10\b", m.lower())
    if m2:
        v = float(m2.group(1) + (m2.group(2) or ""))
        return v if 1 <= v <= 10 else None

    # contains "confidence" and a 1..10 number
    if "confidence" in m.lower():
        m3 = re.search(r"\b(10|[1-9])(\.\d+)?\b", m)
        if m3:
            v = float(m3.group(1) + (m3.group(2) or ""))
            return v if 1 <= v <= 10 else None

    return None


# ---------------------------
# Schemas
# ---------------------------
class HistoryItem(BaseModel):
    role: str
    content: str


class ResourceItem(BaseModel):
    title: str
    url: str
    type: str = ""


class PlanItem(BaseModel):
    label: str
    resources: List[ResourceItem] = Field(default_factory=list)


PlanOut = Union[str, PlanItem]


class ChatIn(BaseModel):
    user_id: str = "local-dev"
    focus: str = "work"
    message: str
    history: Optional[List[HistoryItem]] = []


class ChatOut(BaseModel):
    mode: str
    message: str
    tips: List[str] = []
    plan: List[PlanOut] = []
    question: str = ""


class CheckInIn(BaseModel):
    user_id: str = "local-dev"
    focus: str = "work"
    inactive_hours: int = 18


class CheckInOut(BaseModel):
    should_send: bool
    message: str


# ---------------------------
# Main chat endpoint
# ---------------------------
@router.post("", response_model=ChatOut)
def chat(payload: ChatIn):
    user_msg = (payload.message or "").strip()
    if not user_msg:
        raise HTTPException(status_code=400, detail="message is required")

    st = get_user_state(payload.user_id)
    current_plan = st.get("current_plan", [])
    last_activity = st.get("last_user_activity")
    focus = payload.focus

    # --- Baseline reason follow-up state (per focus) ---
    focus_conf = _get_focus_conf_state(st, focus)
    awaiting_reason = bool(focus_conf.get("awaiting_baseline_reason", False))
    baseline = focus_conf.get("baseline", None)

    # ✅ If we're waiting for the baseline reason, treat this message as the reason,
    # then generate suggestions + plan + resources.
    if awaiting_reason:
        # mark resolved before calling model to avoid loops on errors/retries
        _set_focus_conf_state(payload.user_id, focus, {"awaiting_baseline_reason": False, "baseline_reason": user_msg})

        # continue to Gemini with extra context below (baseline + reason)
        baseline_reason = user_msg
    else:
        baseline_reason = None

        # ✅ If baseline not set yet and user gives a confidence number -> ask "why not higher?"
        if baseline is None:
            level = _parse_confidence_from_message(user_msg)
            if level is not None:
                _set_focus_conf_state(
                    payload.user_id,
                    focus,
                    {
                        "baseline": level,
                        "awaiting_baseline_reason": True,
                        "baseline_set_at": datetime.now(timezone.utc).isoformat(),
                    },
                )
                touch_user(payload.user_id)
                return ChatOut(
                    mode="coach",
                    message=f"Got it — baseline saved as {level}/10 for {focus}. ✅",
                    tips=[],
                    plan=[],
                    question=f"What’s the main reason it feels like a {level} (and not higher)?",
                )

    returning_threshold_hours = 16

    if is_returning(user_msg) and current_plan and should_check_in(last_activity, hours=returning_threshold_hours):
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message="Hey 🙂 Welcome back. Just checking in — how did it go with your plan?",
            tips=[],
            plan=[],
            question="Which step did you manage to do, or what got in the way?",
        )

    if looks_like_progress(user_msg) and current_plan:
        touch_user(payload.user_id)
        return ChatOut(
            mode="coach",
            message="Nice work — that matters. ✅",
            tips=[],
            plan=[],
            question=f"On a scale from 1–10, what’s your confidence level in {focus} now?",
        )

    touch_user(payload.user_id)

    # Build Gemini contents from history + current user message
    history_dicts = []
    if payload.history:
        for h in payload.history:
            try:
                history_dicts.append({"role": h.role, "content": h.content})
            except Exception:
                pass

    contents: List[types.Content] = []
    contents.extend(_history_to_contents(history_dicts, limit=15))
    contents.append(types.Content(role="user", parts=[types.Part(text=user_msg)]))

    # ---------------------------
    # System prompt (updated behavior)
    # ---------------------------
    system = (
        "You are a supportive, friend-like confidence coach.\n"
        "Return ONLY raw JSON (no markdown, no backticks, no extra text).\n"
        "JSON keys:\n"
        "- mode: 'chat' or 'coach'\n"
        "- message: natural reply like a real friend (required)\n"
        "- tips: optional array (0-3) short actionable tips\n"
        "- plan: optional array (0-5) steps\n"
        "- question: optional string (keep empty unless truly needed)\n"
        "\n"
        "IMPORTANT plan format:\n"
        "Prefer returning plan as an array of OBJECTS, not strings.\n"
        "Each plan item object must be:\n"
        "  {\"label\": \"...\", \"resources\": [{\"title\":\"...\",\"url\":\"...\",\"type\":\"article|video|template\"}]}\n"
        "Rules for resources:\n"
        "- If you provide a plan, include 2–3 resources per step.\n"
        "- Use real, public, beginner-friendly links (avoid paywalls when possible).\n"
        "- Mix formats when possible: article + video + template/checklist.\n"
        "- Keep titles short and clear.\n"
        "\n"
        "Behavior rules:\n"
        "- Default mode='chat'.\n"
        "- Use mode='coach' when giving a plan, coaching, or clear next steps.\n"
        "- Don't force tips/plan/question every time.\n"
        "\n"
        "Baseline coaching rule:\n"
        "- If the user shared a baseline reason (why they’re not confident), respond with empathy,\n"
        "  then give 2–3 targeted suggestions, then propose a short plan with learning links.\n"
        "\n"
        "Context you may use:\n"
        f"- User focus: {focus}\n"
        f"- Current plan (if any): {current_plan}\n"
        f"- Baseline confidence (if known): {baseline}\n"
        f"- Baseline reason (if provided): {baseline_reason}\n"
    )

    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                temperature=0.7,
                response_mime_type="application/json",
                system_instruction=system,
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

        plan_clean: List[PlanOut] = []
        if isinstance(plan, list):
            for item in plan:
                if isinstance(item, str):
                    s = item.strip()
                    if s:
                        plan_clean.append(s)
                    continue

                if isinstance(item, dict):
                    label = str(item.get("label", "")).strip()
                    if not label:
                        continue

                    resources_in = item.get("resources", [])
                    resources_out: List[ResourceItem] = []
                    if isinstance(resources_in, list):
                        for r in resources_in[:3]:
                            if not isinstance(r, dict):
                                continue
                            title = str(r.get("title", "")).strip()
                            url = str(r.get("url", "")).strip()
                            rtype = str(r.get("type", "")).strip()
                            if title and url:
                                resources_out.append(ResourceItem(title=title, url=url, type=rtype))

                    plan_clean.append(PlanItem(label=label, resources=resources_out))
                    continue

        plan_clean = plan_clean[:5]

        # Persist plan if model provided one
        if plan_clean:
            serializable: List[Any] = []
            for it in plan_clean:
                if isinstance(it, str):
                    serializable.append(it)
                else:
                    serializable.append(
                        {
                            "label": it.label,
                            "resources": [{"title": r.title, "url": r.url, "type": r.type} for r in it.resources],
                        }
                    )
            set_current_plan(payload.user_id, serializable)

        return ChatOut(
            mode=mode,
            message=message,
            tips=tips_clean,
            plan=plan_clean,
            question=question,
        )

    except HTTPException:
        raise
    except Exception as e:
        print("❌ Gemini error details:", repr(e))
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
            return ChatOut(
                mode="chat",
                message="I’m a bit overloaded right now 😅 Let’s pause for a moment.",
                tips=[],
                plan=[],
                question="Can we pick this up again shortly?",
            )

        print("❌ Gemini error:", repr(e))
        raise HTTPException(status_code=500, detail="AI service error")


# ---------------------------
# Inactivity check-in endpoint
# ---------------------------
@router.post("/checkin", response_model=CheckInOut)
def checkin(payload: CheckInIn):
    st = get_user_state(payload.user_id)
    last = parse_dt(st.get("last_user_activity"))
    plan = st.get("current_plan", [])

    if not last:
        return {"should_send": False, "message": ""}

    now = datetime.now(timezone.utc)
    inactive_for = now - last
    threshold = timedelta(hours=max(1, int(payload.inactive_hours)))

    if inactive_for < threshold:
        return {"should_send": False, "message": ""}

    last_checkin = parse_dt(st.get("last_checkin_at"))
    if last_checkin and (now - last_checkin) < threshold:
        return {"should_send": False, "message": ""}

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
            contents=[types.Content(role="user", parts=[types.Part(text=json.dumps(prompt, ensure_ascii=False))])],
            config=types.GenerateContentConfig(
                temperature=0.6,
                system_instruction=system,
            ),
        )
        msg = (resp.text or "").strip()

        if not msg:
            msg = "Hey — quick check-in. How did today go with your plan?"

        touch_checkin(payload.user_id, payload.focus)
        return {"should_send": True, "message": msg}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini check-in error: {str(e)}")
