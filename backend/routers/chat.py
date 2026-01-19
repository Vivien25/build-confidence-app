import os
import json
import re
from typing import List, Optional, Dict, Any, Union
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


def touch_user(user_id: str) -> None:
    state = _load_state()
    st = state.get(user_id, {})
    st["last_user_activity"] = datetime.now(timezone.utc).isoformat()
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


def _today_iso_date() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# ---------------------------
# Plan store (per focus+need)
# Backward-compatible:
# - if st["current_plan"] is a list -> legacy single plan
# - if dict -> keyed by plan_key
# ---------------------------
def get_current_plan(st: Dict[str, Any], plan_key: str) -> List[Any]:
    cp = st.get("current_plan", [])
    if isinstance(cp, list):
        return cp
    if isinstance(cp, dict):
        v = cp.get(plan_key, [])
        return v if isinstance(v, list) else []
    return []


def set_current_plan(user_id: str, plan_key: str, plan: List[Any]) -> None:
    state = _load_state()
    st = state.get(user_id, {})

    cp = st.get("current_plan", {})
    if isinstance(cp, list):
        cp = {"legacy": cp}
    if not isinstance(cp, dict):
        cp = {}
    cp[plan_key] = plan
    st["current_plan"] = cp

    lps = st.get("last_plan_set_at", {})
    if isinstance(lps, str):
        lps = {"legacy": lps}
    if not isinstance(lps, dict):
        lps = {}
    lps[plan_key] = datetime.now(timezone.utc).isoformat()
    st["last_plan_set_at"] = lps

    state[user_id] = st
    _save_state(state)


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
# Confidence state (per focus+need)
# Stored under st["confidence"][conf_key]
# ---------------------------
def _get_conf_bucket(st: Dict[str, Any], key: str) -> Dict[str, Any]:
    conf = st.get("confidence", {})
    if not isinstance(conf, dict):
        conf = {}
    bucket = conf.get(key, {})
    if not isinstance(bucket, dict):
        bucket = {}
    return bucket


def _patch_conf_bucket(user_id: str, key: str, patch: Dict[str, Any]) -> None:
    state = _load_state()
    st = state.get(user_id, {})
    conf = st.get("confidence", {})
    if not isinstance(conf, dict):
        conf = {}
    bucket = conf.get(key, {})
    if not isinstance(bucket, dict):
        bucket = {}
    bucket.update(patch)
    conf[key] = bucket
    st["confidence"] = conf
    state[user_id] = st
    _save_state(state)


# ---------------------------
# Intent helpers (friend-like)
# ---------------------------
EMOTION_WORDS = {
    "nervous",
    "anxious",
    "anxiety",
    "stressed",
    "stress",
    "overwhelmed",
    "sad",
    "lonely",
    "worried",
    "scared",
    "panic",
    "frustrated",
    "upset",
    "tired",
    "burned out",
    "burnt out",
    "afraid",
}

PLAN_TRIGGERS = {
    "plan",
    "steps",
    "what should i do",
    "help me",
    "can you help",
    "strategy",
    "roadmap",
    "schedule",
    "next steps",
    "action items",
}

NO_PLAN_PATTERNS = [
    r"\bnot now\b",
    r"\bjust chat\b",
    r"\bjust talk\b",
    r"\bjust listen\b",
    r"\bjust listening\b",
    r"\bno plan\b",
    r"\bno more plans\b",
    r"\bdon't give (me )?a plan\b",
    r"\bdo not give (me )?a plan\b",
]

# ✅ IMPORTANT: "yes/ok/sure" are NOT plan requests.
# Only plan-specific phrases go here.
YES_PLAN_PATTERNS = [
    r"\bgive me (a )?plan\b",
    r"\bmake (me )?a plan\b",
    r"\bcreate (a )?plan\b",
    r"\bwrite (a )?plan\b",
    r"\baction plan\b",
    r"\bnext steps\b",
    r"\broadmap\b",
    r"\bsteps\b",
]

# ✅ Generic affirmation (only meaningful when pending_offer=True)
AFFIRM_PATTERNS = [
    r"\byes\b",
    r"\byeah\b",
    r"\byep\b",
    r"\bok\b",
    r"\bokay\b",
    r"\bsure\b",
    r"\balright\b",
]

REVISION_PATTERNS = [
    r"\brev(i|ise|ision)\b",
    r"\bchange\b",
    r"\bmodify\b",
    r"\bupdate\b",
    r"\badjust\b",
    r"\bmake it (easier|harder|shorter|longer|simpler|more detailed)\b",
]
NEW_PLAN_PATTERNS = [
    r"\bnew plan\b",
    r"\banother plan\b",
    r"\bdifferent plan\b",
    r"\breplace (the )?plan\b",
    r"\bstart over\b",
]


def _explicit_no_plan(msg: str) -> bool:
    t = (msg or "").lower().strip()
    return any(re.search(p, t) for p in NO_PLAN_PATTERNS)


def _explicit_yes_plan(msg: str) -> bool:
    t = (msg or "").lower().strip()
    return any(re.search(p, t) for p in YES_PLAN_PATTERNS)


def _is_affirmation(msg: str) -> bool:
    t = (msg or "").lower().strip()
    return any(re.search(p, t) for p in AFFIRM_PATTERNS)


def _wants_plan(msg: str) -> bool:
    t = (msg or "").lower()
    return any(p in t for p in PLAN_TRIGGERS)


def _wants_new_or_revision(msg: str) -> bool:
    t = (msg or "").lower().strip()
    return any(re.search(p, t) for p in REVISION_PATTERNS + NEW_PLAN_PATTERNS)


def _is_emotional(msg: str) -> bool:
    t = (msg or "").lower()
    return any(w in t for w in EMOTION_WORDS)


def is_smalltalk_greeting(msg: str) -> bool:
    t = (msg or "").strip().lower()
    return t in {"hi", "hello", "hey", "hiya", "yo"} or bool(re.fullmatch(r"(hi|hello|hey)[!.\s]*", t))


def is_returning(msg: str) -> bool:
    if not msg:
        return False
    m = msg.lower().strip()
    patterns = [
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


def _looks_like_user_wants_support(msg: str) -> bool:
    """
    Heuristic: user sharing a situation/problem/feeling where offering a plan could help,
    but they did NOT ask for a plan yet.
    """
    t = (msg or "").lower()
    if not t:
        return False
    if is_smalltalk_greeting(t):
        return False
    if _wants_plan(t) or _explicit_yes_plan(t) or _explicit_no_plan(t) or _wants_new_or_revision(t):
        return False

    signals = [
        "i don't know",
        "not sure",
        "confused",
        "hard",
        "difficult",
        "struggling",
        "stuck",
        "can't",
        "cannot",
        "worried",
        "overwhelmed",
        "stress",
        "stressed",
        "anxious",
        "nervous",
        "frustrated",
        "upset",
        "want to improve",
        "improve it",
    ]
    return any(s in t for s in signals) or _is_emotional(t)


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
    need_key: str = "interview"
    need_label: str = "Interview confidence"
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
    need_key: str = "interview"
    need_label: str = "Interview confidence"
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

    focus = (payload.focus or "work").strip().lower()
    need_key = (payload.need_key or "interview").strip().lower()
    need_label = (payload.need_label or "").strip() or need_key.replace("_", " ").title()

    # ✅ per-focus + per-need keys
    plan_key = f"{focus}::{need_key}"
    conf_key = plan_key

    st = get_user_state(payload.user_id)
    current_plan = get_current_plan(st, plan_key)
    has_plan = bool(current_plan)
    last_activity = st.get("last_user_activity")

    conf_bucket = _get_conf_bucket(st, conf_key)

    # baseline state for THIS need
    awaiting_baseline_reason = bool(conf_bucket.get("awaiting_baseline_reason", False))
    baseline = conf_bucket.get("baseline", None)

    # gating flags (per need)
    pending_offer = bool(conf_bucket.get("pending_plan_offer", False))
    pending_plan_conf = bool(conf_bucket.get("pending_plan_confidence", False))
    pending_progress_conf = bool(conf_bucket.get("pending_progress_confidence", False))  # ✅ NEW
    today = _today_iso_date()

    # ------------------------------------
    # Hard rule: greetings should be chat
    # ------------------------------------
    if is_smalltalk_greeting(user_msg):
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message="Hey 🙂 I’m here.",
            tips=[],
            plan=[],
            question=f"How are you feeling about **{need_label}** today?",
        )

    # ------------------------------------
    # Baseline flow (per need)
    # 1) user gives baseline number -> ask reason
    # 2) user gives reason -> allow plan generation
    # ------------------------------------
    if awaiting_baseline_reason:
        # treat this as baseline reason and end this flow
        _patch_conf_bucket(
            payload.user_id,
            conf_key,
            {
                "awaiting_baseline_reason": False,
                "baseline_reason": user_msg,
                # ✅ clear any stale gating flags
                "pending_plan_offer": False,
                "pending_plan_confidence": False,
                "pending_progress_confidence": False,
            },
        )
        baseline_reason = user_msg
    else:
        baseline_reason = None
        if baseline is None:
            level = _parse_confidence_from_message(user_msg)
            if level is not None:
                _patch_conf_bucket(
                    payload.user_id,
                    conf_key,
                    {
                        "baseline": level,
                        "awaiting_baseline_reason": True,
                        "baseline_set_at": datetime.now(timezone.utc).isoformat(),
                        # ✅ clear any stale gating flags
                        "pending_plan_offer": False,
                        "pending_plan_confidence": False,
                        "pending_progress_confidence": False,
                    },
                )
                touch_user(payload.user_id)
                return ChatOut(
                    mode="chat",
                    message=f"Got it — baseline saved as {level}/10 for **{need_label}**. ✅",
                    tips=[],
                    plan=[],
                    question=f"What’s the main reason it feels like a {level} (and not higher)?",
                )

    # ------------------------------------
    # Gate #1: If we previously offered a plan,
    # interpret yes/no FIRST (no Gemini).
    # ------------------------------------
    plan_allowed_for_this_turn = False

    if pending_offer:
        # user declines plans
        if _explicit_no_plan(user_msg):
            _patch_conf_bucket(payload.user_id, conf_key, {"pending_plan_offer": False})
            touch_user(payload.user_id)
            return ChatOut(
                mode="chat",
                message="Totally okay — no plans. I’m here with you. 🙂",
                tips=[],
                plan=[],
                question="What part is the hardest right now?",
            )

        # ✅ user accepts offer with generic affirmation OR explicit plan request
        if _is_affirmation(user_msg) or _explicit_yes_plan(user_msg) or _wants_plan(user_msg):
            # if they included a number in the same message, proceed immediately
            level = _parse_confidence_from_message(user_msg)
            if level is not None:
                _patch_conf_bucket(
                    payload.user_id,
                    conf_key,
                    {
                        "pending_plan_offer": False,
                        "pending_plan_confidence": False,
                        "pending_progress_confidence": False,
                        "last_confidence_date": today,
                        "last_confidence_value": level,
                    },
                )
                plan_allowed_for_this_turn = True
            else:
                _patch_conf_bucket(
                    payload.user_id,
                    conf_key,
                    {"pending_plan_offer": False, "pending_plan_confidence": True},
                )
                touch_user(payload.user_id)
                return ChatOut(
                    mode="chat",
                    message="Okay — I can make a small plan. First I want to calibrate it.",
                    tips=[],
                    plan=[],
                    question=f"On a scale of 1–10, how confident do you feel about **{need_label}** right now?",
                )
        else:
            # not a yes/no; treat as regular chat and clear offer
            _patch_conf_bucket(payload.user_id, conf_key, {"pending_plan_offer": False})
            plan_allowed_for_this_turn = False

    # ------------------------------------
    # Gate #2: If we are waiting for a confidence
    # rating before planning, do that now.
    # ------------------------------------
    if pending_plan_conf:
        level = _parse_confidence_from_message(user_msg)
        if level is None:
            # If user is confused ("for what?"), explain once (no loop-nagging)
            t = user_msg.lower().strip()
            if any(p in t for p in ["for what", "what for", "why", "why do you need", "what does it mean", "huh"]):
                touch_user(payload.user_id)
                return ChatOut(
                    mode="chat",
                    message=(
                        f"For your **{need_label}** 🙂 "
                        "It helps me tune the plan to the right difficulty."
                    ),
                    tips=[],
                    plan=[],
                    question=f"So what number would you give your **{need_label}** right now (1–10)?",
                )

            touch_user(payload.user_id)
            return ChatOut(
                mode="chat",
                message=f"On a scale from 1–10, how confident do you feel about **{need_label}** right now?",
                tips=[],
                plan=[],
                question=f"Just reply with a number 1–10 for **{need_label}** 🙂",
            )

        _patch_conf_bucket(
            payload.user_id,
            conf_key,
            {
                "pending_plan_confidence": False,
                "pending_progress_confidence": False,
                "last_confidence_date": today,
                "last_confidence_value": level,
            },
        )
        plan_allowed_for_this_turn = True

    # ------------------------------------
    # ✅ NEW Gate: progress confidence follow-up
    # When we asked "1–10 confidence now?" after progress,
    # consume the next numeric message here (prevents looping).
    # ------------------------------------
    if pending_progress_conf:
        level = _parse_confidence_from_message(user_msg)
        if level is None:
            touch_user(payload.user_id)
            return ChatOut(
                mode="chat",
                message="Just reply with a number from 1–10 🙂",
                tips=[],
                plan=[],
                question=f"What number would you give your **{need_label}** right now?",
            )

        _patch_conf_bucket(
            payload.user_id,
            conf_key,
            {
                "pending_progress_confidence": False,
                "last_confidence_date": today,
                "last_confidence_value": level,
            },
        )
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message=f"Got it — {level}/10. ✅",
            tips=[],
            plan=[],
            question="What’s one small thing that would move it up by 1 point?",
        )

    # ------------------------------------
    # Returning / progress check-ins (light)
    # ------------------------------------
    returning_threshold_hours = 16

    if is_returning(user_msg) and has_plan and should_check_in(last_activity, hours=returning_threshold_hours):
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message="Hey 🙂 Welcome back. How did it go with your plan?",
            tips=[],
            plan=[],
            question="What did you manage to do — or what got in the way?",
        )

    # ✅ UPDATED: set pending flag when asking progress-confidence
    if looks_like_progress(user_msg) and has_plan:
        _patch_conf_bucket(payload.user_id, conf_key, {"pending_progress_confidence": True})
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message="Nice — that matters. ✅",
            tips=[],
            plan=[],
            question=f"On a scale from 1–10, what’s your confidence in **{need_label}** right now?",
        )

    # ------------------------------------
    # After a short chat, offer plan permission
    # (but do NOT generate plan yet)
    # ✅ UPDATED: if a plan already exists, do NOT re-offer a new plan
    # ------------------------------------
    if (not pending_offer) and (not pending_plan_conf) and _looks_like_user_wants_support(user_msg):
        if has_plan:
            touch_user(payload.user_id)
            return ChatOut(
                mode="chat",
                message="I hear you. Want to stick with your current plan, or tweak it a bit?",
                tips=[],
                plan=[],
                question="What part feels hardest right now?",
            )

        _patch_conf_bucket(payload.user_id, conf_key, {"pending_plan_offer": True})
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message="I hear you. Want me to just listen, or would a small plan help?",
            tips=[],
            plan=[],
            question=f"If you want a plan, I’ll ask one quick thing first: what’s your confidence in **{need_label}** (1–10)?",
        )

    # If they explicitly say "no plan" at any time (outside pending_offer), honor it and stay chatty
    if _explicit_no_plan(user_msg):
        _patch_conf_bucket(
            payload.user_id,
            conf_key,
            {
                "pending_plan_offer": False,
                "pending_plan_confidence": False,
                "pending_progress_confidence": False,
            },
        )
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message="Got it — no plans for now. We can just talk.",
            tips=[],
            plan=[],
            question="What’s on your mind?",
        )

    # If they explicitly ask for a plan/revision, require confidence first (unless they include it now)
    asked_for_plan_now = _wants_plan(user_msg) or _explicit_yes_plan(user_msg) or _wants_new_or_revision(user_msg)
    confidence_in_msg = _parse_confidence_from_message(user_msg)

    if asked_for_plan_now and baseline is not None and not plan_allowed_for_this_turn:
        # If they already included confidence in this message, proceed.
        if confidence_in_msg is not None:
            _patch_conf_bucket(
                payload.user_id,
                conf_key,
                {"last_confidence_date": today, "last_confidence_value": confidence_in_msg},
            )
            plan_allowed_for_this_turn = True
        else:
            _patch_conf_bucket(payload.user_id, conf_key, {"pending_plan_confidence": True})
            touch_user(payload.user_id)
            return ChatOut(
                mode="chat",
                message="Sure — I can help with a plan. First I want to calibrate it.",
                tips=[],
                plan=[],
                question=f"On a scale of 1–10, how confident do you feel about **{need_label}** right now?",
            )

    # If user is emotional and not asking for plan, keep it friend-only (no plan/tips)
    if _is_emotional(user_msg) and not asked_for_plan_now and not plan_allowed_for_this_turn and baseline_reason is None:
        touch_user(payload.user_id)
        return ChatOut(
            mode="chat",
            message="I’m really glad you told me. I’m here with you.",
            tips=[],
            plan=[],
            question="What part is hitting you the hardest right now?",
        )

    touch_user(payload.user_id)

    # Build Gemini contents
    history_dicts: List[Dict[str, str]] = []
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
    # System prompt (friend-first)
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
        "Plan format (ONLY if a plan is appropriate):\n"
        "Prefer plan as an array of OBJECTS, not strings.\n"
        "Each plan item object must be:\n"
        "  {\"label\":\"...\",\"resources\":[{\"title\":\"...\",\"url\":\"...\",\"type\":\"article|video|template\"}]}\n"
        "If you include a plan, include 2–3 resources per step with real public beginner-friendly links.\n"
        "\n"
        "Behavior rules:\n"
        "- Default mode='chat'.\n"
        "- If user is sharing feelings and did NOT ask for a plan, respond like a real friend:\n"
        "  empathy + 1 gentle question. NO plan.\n"
        "- If user did NOT ask for a plan but planning could help, ask:\n"
        "  \"Do you want a small plan, or would you rather just talk for now?\" and do NOT output a plan.\n"
        "- Only output a plan if the user clearly wants one AND it makes sense.\n"
        "- IMPORTANT: If Current plan exists = True, DO NOT output a new plan unless the user explicitly asks\n"
        "  for a NEW plan or to revise/replace the plan.\n"
        "\n"
        "Baseline coaching rule:\n"
        "- If baseline reason is provided, respond with empathy, then 2–3 targeted suggestions, then propose a short plan.\n"
        "\n"
        "Context:\n"
        f"- Focus: {focus}\n"
        f"- Need key: {need_key}\n"
        f"- Need label: {need_label}\n"
        f"- Current plan exists: {has_plan}\n"
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

        plan_clean = plan_clean[:5]

        # ------------------------------------
        # HARD-BLOCK: only allow plans when:
        # - baseline_reason flow (first plan after baseline reason), OR
        # - plan_allowed_for_this_turn (user agreed + we checked confidence), OR
        # - user explicitly asked AND included confidence in same message
        # ------------------------------------
        allow_plan_output = False
        confidence_in_same_msg = _parse_confidence_from_message(user_msg) is not None

        if baseline_reason is not None:
            allow_plan_output = True
        elif plan_allowed_for_this_turn:
            allow_plan_output = True
        elif asked_for_plan_now and confidence_in_same_msg:
            allow_plan_output = True

        if plan_clean and not allow_plan_output:
            plan_clean = []
            tips_clean = []  # keep friend-like if we block plan
            mode = "chat"
            if not question:
                question = f"Do you want a small plan for **{need_label}**, or would you rather just talk for now?"

        if plan_clean and allow_plan_output:
            mode = "coach"

        # Persist plan per focus+need ONLY if allowed and a plan exists
        if plan_clean and allow_plan_output:
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
            set_current_plan(payload.user_id, plan_key, serializable)

        return ChatOut(
            mode=mode,
            message=message,
            tips=tips_clean,
            plan=plan_clean if allow_plan_output else [],
            question=question,
        )

    except HTTPException:
        raise
    except Exception as e:
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
# Inactivity check-in endpoint (per focus+need)
# ---------------------------
@router.post("/checkin", response_model=CheckInOut)
def checkin(payload: CheckInIn):
    focus = (payload.focus or "work").strip().lower()
    need_key = (payload.need_key or "interview").strip().lower()
    need_label = (payload.need_label or "").strip() or need_key.replace("_", " ").title()
    plan_key = f"{focus}::{need_key}"

    st = get_user_state(payload.user_id)
    last = parse_dt(st.get("last_user_activity"))
    plan = get_current_plan(st, plan_key)

    if not last:
        return {"should_send": False, "message": ""}

    now = datetime.now(timezone.utc)
    inactive_for = now - last
    threshold = timedelta(hours=max(1, int(payload.inactive_hours)))

    if inactive_for < threshold:
        return {"should_send": False, "message": ""}

    # per-key checkin throttle
    last_checkins = st.get("last_checkin_at", {})
    last_checkin_iso = None
    if isinstance(last_checkins, dict):
        last_checkin_iso = last_checkins.get(plan_key)
    elif isinstance(last_checkins, str):
        last_checkin_iso = last_checkins

    last_checkin = parse_dt(last_checkin_iso)
    if last_checkin and (now - last_checkin) < threshold:
        return {"should_send": False, "message": ""}

    system = (
        "You are a supportive friend-like coach.\n"
        "Write ONE short check-in message.\n"
        "If a plan exists, ask about it lightly (no pressure).\n"
        "Keep it under 2 sentences.\n"
        "Be warm, non-judgmental, and easy to reply to.\n"
    )

    prompt = {
        "focus": focus,
        "need": need_label,
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
            msg = f"Hey — quick check-in. How are you feeling about {need_label} today?"

        # store checkin per plan_key
        state = _load_state()
        st2 = state.get(payload.user_id, {})
        lc = st2.get("last_checkin_at", {})
        if isinstance(lc, str):
            lc = {"legacy": lc}
        if not isinstance(lc, dict):
            lc = {}
        lc[plan_key] = datetime.now(timezone.utc).isoformat()
        st2["last_checkin_at"] = lc
        state[payload.user_id] = st2
        _save_state(state)

        return {"should_send": True, "message": msg}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini check-in error: {str(e)}")
