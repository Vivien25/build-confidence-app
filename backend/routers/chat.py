# backend/chat.py
import os
import json
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from google import genai
from google.genai import types

router = APIRouter(prefix="/chat", tags=["chat"])

# ---------------------------
# Gemini client
# ---------------------------
API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if not API_KEY:
    raise RuntimeError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) in backend/.env")

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
client = genai.Client(api_key=API_KEY)

# ---------------------------
# Tiny JSON-file state store
# ---------------------------
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = DATA_DIR / "user_state.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_read_json(path: Path, fallback: Any) -> Any:
    try:
        if not path.exists():
            return fallback
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _safe_write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _load_all_state() -> Dict[str, Any]:
    return _safe_read_json(STATE_FILE, {})


def _save_all_state(all_state: Dict[str, Any]) -> None:
    _safe_write_json(STATE_FILE, all_state)


def _get_user_bucket(all_state: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    if user_id not in all_state:
        all_state[user_id] = {}
    return all_state[user_id]


# ---------------------------
# Request / Response models
# ---------------------------
class ChatRequest(BaseModel):
    user_id: str = Field(..., description="Stable id (email, uuid, etc.)")
    message: str = Field(..., description="User message text")

    # Optional context from frontend (safe to ignore if you don't send them)
    coach: Optional[str] = None
    profile: Optional[Dict[str, Any]] = None

    # Optional: frontend can pass a topic to avoid guessing
    topic: Optional[str] = None


class CoachMessage(BaseModel):
    role: str = "coach"
    text: str


class UIState(BaseModel):
    mode: str
    show_plan_sidebar: bool = False
    plan_link: Optional[str] = None
    mermaid: Optional[str] = None


class Effects(BaseModel):
    saved_confidence: bool = False
    created_plan_id: Optional[str] = None
    updated_plan_id: Optional[str] = None


class ChatResponse(BaseModel):
    messages: List[CoachMessage]
    ui: UIState
    effects: Effects
    plan: Optional[Dict[str, Any]] = None


# ---------------------------
# State schema
# ---------------------------
DEFAULT_STATE = {
    "mode": "CHAT",  # CHAT | PLAN_BUILD | CHECKIN (future)
    "history": [],  # list[{role,text,ts}]
    "metrics": {
        "confidence": {
            # topic_key -> {baseline,last,updated_at}
        }
    },
    "plan_build": {
        "step": "DISCOVERY",  # DISCOVERY | DRAFT | REFINE
        "topic": None,  # topic_key
        "discovery_questions_asked": 0,
        "discovery_answers": {},  # freeform dict
        "active_plan_id": None,
        "locked": False,  # plan stability guarantee
    },
    "plans": {
        # plan_id -> plan object
    },
}


def _ensure_state_shape(state: Dict[str, Any]) -> Dict[str, Any]:
    # Shallow merge defaults; keep existing nested content if present.
    merged = json.loads(json.dumps(DEFAULT_STATE))
    for k, v in state.items():
        merged[k] = v
    # Ensure nested keys
    merged.setdefault("history", [])
    merged.setdefault("metrics", {"confidence": {}})
    merged["metrics"].setdefault("confidence", {})
    merged.setdefault("plan_build", {})
    for k, v in DEFAULT_STATE["plan_build"].items():
        merged["plan_build"].setdefault(k, v)
    merged.setdefault("plans", {})
    return merged


# ---------------------------
# Intent / Topic router
# ---------------------------
_NEW_PLAN_PATTERNS = [
    r"\bnew plan\b",
    r"\bcreate a new plan\b",
    r"\bmake a new plan\b",
    r"\bstart over\b",
    r"\brestart\b",
    r"\bredo\b",
    r"\bre-do\b",
    r"\breplace the plan\b",
    r"\bthis plan (doesn'?t|does not) work\b",
]

_PLAN_REQUEST_PATTERNS = [
    r"\bplan\b",
    r"\broadmap\b",
    r"\bschedule\b",
    r"\bprep\b",
    r"\bprepare\b",
    r"\bhelp me\b",
    r"\borganize\b",
    r"\bgame plan\b",
]

_REFINE_PATTERNS = [
    r"\badjust\b",
    r"\brefine\b",
    r"\bedit\b",
    r"\bupdate\b",
    r"\bshorter\b",
    r"\blonger\b",
    r"\bfocus on\b",
    r"\badd\b",
    r"\bremove\b",
    r"\bchange\b",
]

_SKIP_PATTERNS = [
    r"\bskip\b",
    r"\bjust chat\b",
    r"\bno plan\b",
    r"\bstop\b",
    r"\bnot now\b",
]


def _matches_any(text: str, patterns: List[str]) -> bool:
    t = (text or "").lower()
    return any(re.search(p, t) for p in patterns)


def explicit_new_plan_request(user_text: str) -> bool:
    return _matches_any(user_text, _NEW_PLAN_PATTERNS)


def plan_requested(user_text: str) -> bool:
    return _matches_any(user_text, _PLAN_REQUEST_PATTERNS)


def refine_requested(user_text: str) -> bool:
    return _matches_any(user_text, _REFINE_PATTERNS)


def skip_requested(user_text: str) -> bool:
    return _matches_any(user_text, _SKIP_PATTERNS)


def normalize_topic_key(topic: Optional[str]) -> Optional[str]:
    if not topic:
        return None
    t = topic.strip().lower()
    # Allow frontend to pass an exact key like "interview_confidence"
    t = re.sub(r"[^a-z0-9_]+", "_", t)
    t = re.sub(r"_+", "_", t).strip("_")
    return t or None


def infer_topic_key(user_text: str, profile: Optional[Dict[str, Any]] = None) -> str:
    """
    Light heuristic topic detection. You can expand this over time.
    """
    t = (user_text or "").lower()

    # Strong signals
    if any(k in t for k in ["interview", "behavioral", "system design", "leetcode", "ml ops", "mle", "data engineer"]):
        return "interview_confidence"

    if any(k in t for k in ["work", "job", "boss", "coworker", "deadline", "productivity", "focus"]):
        return "work_focus"

    if any(k in t for k in ["relationship", "partner", "husband", "wife", "dating", "communication"]):
        return "relationship_communication"

    if any(k in t for k in ["appearance", "body image", "looks", "weight", "skin", "hair"]):
        return "appearance_confidence"

    # Profile fallback (if you store focus there)
    if profile and isinstance(profile, dict):
        focus = str(profile.get("focus") or "").lower()
        if focus:
            return normalize_topic_key(focus) or "general"

    return "general"


def decide_mode_and_step(state: Dict[str, Any], user_text: str, topic_key: str) -> Tuple[str, Optional[str]]:
    """
    Deterministic router:
    - Default CHAT.
    - PLAN_BUILD when user requests plan or refinement.
    - If user says skip, go CHAT.
    """
    if skip_requested(user_text):
        return "CHAT", None

    pb = state["plan_build"]
    has_active_plan = bool(pb.get("active_plan_id")) and pb.get("topic") == topic_key

    # Explicit new plan overrides lock.
    if explicit_new_plan_request(user_text):
        return "PLAN_BUILD", "DRAFT"

    # If they ask to refine and we have a plan, go refine.
    if refine_requested(user_text) and has_active_plan:
        return "PLAN_BUILD", "REFINE"

    # If they ask for a plan (or likely want one)
    if plan_requested(user_text):
        # If plan exists for this topic and no explicit new plan request -> refine
        if has_active_plan:
            return "PLAN_BUILD", "REFINE"
        return "PLAN_BUILD", "DISCOVERY"

    # Otherwise stay in current mode unless plan_build is mid-flight
    if state.get("mode") == "PLAN_BUILD":
        # Continue plan build flow, but enforce lock behavior later
        return "PLAN_BUILD", pb.get("step") or "DISCOVERY"

    return "CHAT", None


# ---------------------------
# Plan lock rule
# ---------------------------
def should_create_new_plan(state: Dict[str, Any], user_text: str, topic_key: str) -> bool:
    pb = state["plan_build"]
    active_id = pb.get("active_plan_id")
    active_topic = pb.get("topic")

    if not active_id:
        return True
    if active_topic != topic_key:
        return True
    if explicit_new_plan_request(user_text):
        return True
    return False


# ---------------------------
# Gemini helpers
# ---------------------------
def gemini_text(system: str, user: str) -> str:
    """
    Minimal, reliable text generation (no JSON schema).
    """
    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Content(role="user", parts=[types.Part(text=f"{system}\n\nUSER:\n{user}")]),
            ],
            config=types.GenerateContentConfig(
                temperature=0.7,
                max_output_tokens=700,
            ),
        )
        # SDK returns candidates; .text is usually present
        text = getattr(resp, "text", None)
        if text:
            return text.strip()
        # Fallback: try candidates
        if getattr(resp, "candidates", None):
            parts = resp.candidates[0].content.parts
            return "".join([p.text for p in parts if getattr(p, "text", None)]).strip()
        return ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini error: {e}")


def extract_bullets(text: str, max_items: int = 10) -> List[str]:
    lines = [ln.strip() for ln in (text or "").splitlines()]
    bullets = []
    for ln in lines:
        ln = re.sub(r"^\s*[-*•]\s+", "", ln).strip()
        ln = re.sub(r"^\s*\d+\.\s+", "", ln).strip()
        if not ln:
            continue
        # Avoid super long lines
        if len(ln) > 160:
            ln = ln[:157].rstrip() + "…"
        bullets.append(ln)
        if len(bullets) >= max_items:
            break
    return bullets


# ---------------------------
# Confidence: non-blocking metadata
# ---------------------------
def maybe_capture_confidence(state: Dict[str, Any], user_text: str, topic_key: str) -> bool:
    """
    If user sends a single number 1-10 (or '5/10'), capture as confidence.
    This MUST NOT affect planning transitions.
    """
    t = (user_text or "").strip().lower()
    m = re.fullmatch(r"(\d{1,2})(?:\s*/\s*10)?", t)
    if not m:
        return False
    val = int(m.group(1))
    if val < 0 or val > 10:
        return False

    conf = state["metrics"]["confidence"].setdefault(topic_key, {})
    if "baseline" not in conf:
        conf["baseline"] = val
    conf["last"] = val
    conf["updated_at"] = _now_iso()
    return True


# ---------------------------
# Plan building primitives
# ---------------------------
DISCOVERY_QUESTIONS = [
    "When is the deadline (or when do you want to feel ready)? If you’re not sure, just say “soon.”",
    "What’s the main target: ML Ops / Data Engineering / both? (One word is fine.)",
]


def build_plan_object(topic_key: str, discovery_answers: Dict[str, Any], user_text: str) -> Dict[str, Any]:
    """
    Create a plan deterministically, using Gemini only to suggest tasks.
    Always returns a full plan object.
    """
    # Create a short prompt for task ideas
    deadline = discovery_answers.get("deadline") or "soon"
    target = discovery_answers.get("target") or "mixed"

    system = (
        "You are a practical, concise coach. Suggest a simple interview prep plan. "
        "Return ONLY a bullet list of actionable tasks (no headings, no paragraphs). "
        "Tasks should be specific and doable in 30–90 minutes."
    )
    user = (
        f"Topic: {topic_key}\n"
        f"Deadline: {deadline}\n"
        f"Target: {target}\n"
        f"User context: {user_text}\n"
        "Give 8–10 tasks."
    )
    ideas = gemini_text(system, user)
    tasks = extract_bullets(ideas, max_items=10)

    if not tasks:
        # Hard fallback (never return empty)
        tasks = [
            "Write a 6–8 line story: your background + what role you want + why.",
            "Review core concepts and make a 1-page cheat sheet.",
            "Do one mock interview question and write a better second answer.",
            "Pick 2 projects and practice explaining them in 2 minutes each.",
            "Practice 5 common behavioral questions with STAR format.",
            "Review one system design pattern relevant to the role.",
            "Do 30 minutes of coding practice (easy/medium).",
            "Create a checklist for interview day and logistics.",
        ]

    plan_id = f"plan_{uuid4().hex[:8]}"
    title_map = {
        "interview_confidence": "Interview Confidence Plan",
        "work_focus": "Work Focus Plan",
        "relationship_communication": "Relationship Communication Plan",
        "appearance_confidence": "Appearance Confidence Plan",
        "general": "Personal Improvement Plan",
    }
    title = title_map.get(topic_key, "Personal Plan")

    plan = {
        "id": plan_id,
        "topic": topic_key,
        "title": title,
        "goal": f"Make steady progress on {title.lower()}",
        "milestones": [
            {"name": "Get clarity", "status": "todo"},
            {"name": "Build reps", "status": "todo"},
            {"name": "Polish & confidence", "status": "todo"},
        ],
        "tasks": [{"text": t, "status": "todo"} for t in tasks],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    return plan


def plan_to_mermaid(plan: Dict[str, Any]) -> str:
    """
    Optional: Mermaid diagram for sidebar. Keep it small and safe.
    """
    title = (plan.get("title") or "Plan").replace('"', "'")
    tasks = plan.get("tasks") or []
    # Limit nodes to avoid huge charts
    nodes = tasks[:6]
    lines = [f'flowchart TD', f'A["{title}"]']
    for i, t in enumerate(nodes, start=1):
        txt = (t.get("text") or "").replace('"', "'")
        node_id = f"T{i}"
        lines.append(f'{node_id}["{txt}"]')
        lines.append(f"A --> {node_id}")
    return "\n".join(lines)


# ---------------------------
# Mode handlers
# ---------------------------
def handle_chat(state: Dict[str, Any], user_text: str, topic_key: str, saved_conf: bool) -> ChatResponse:
    # Friendly chat response; keep it short.
    system = (
        "You are a friendly, helpful coach. Keep responses short and natural. "
        "Do NOT create a plan unless user asks for one. "
        "If user seems stressed, offer help in one sentence."
    )
    if saved_conf:
        # Acknowledge without gating.
        user = (
            f"The user just provided a confidence number for topic '{topic_key}'. "
            f"User message: {user_text}\n"
            "Reply briefly. Do not ask more calibration questions."
        )
    else:
        user = user_text

    text = gemini_text(system, user)

    return ChatResponse(
        messages=[CoachMessage(text=text)],
        ui=UIState(mode="CHAT", show_plan_sidebar=bool(state["plan_build"].get("active_plan_id"))),
        effects=Effects(saved_confidence=saved_conf),
        plan=None,
    )


def handle_plan_discovery(state: Dict[str, Any], user_text: str, topic_key: str) -> ChatResponse:
    pb = state["plan_build"]
    pb["topic"] = topic_key
    pb["step"] = "DISCOVERY"

    # Record answer if we previously asked a question
    # We map answers by question index.
    q_asked = int(pb.get("discovery_questions_asked") or 0)
    if q_asked > 0:
        # Store last answer using the previous question slot
        idx = q_asked - 1
        if idx == 0:
            pb["discovery_answers"]["deadline"] = user_text.strip()
        elif idx == 1:
            pb["discovery_answers"]["target"] = user_text.strip()

    # Enforce max 2 questions then draft.
    if q_asked >= len(DISCOVERY_QUESTIONS):
        pb["step"] = "DRAFT"
        return handle_plan_draft(state, user_text, topic_key)

    question = DISCOVERY_QUESTIONS[q_asked]
    pb["discovery_questions_asked"] = q_asked + 1

    return ChatResponse(
        messages=[CoachMessage(text=question)],
        ui=UIState(mode="PLAN_BUILD", show_plan_sidebar=True),
        effects=Effects(),
        plan=None,
    )


def handle_plan_draft(state: Dict[str, Any], user_text: str, topic_key: str) -> ChatResponse:
    pb = state["plan_build"]
    pb["topic"] = topic_key
    pb["step"] = "DRAFT"

    # Plan stability guarantee
    if not should_create_new_plan(state, user_text, topic_key):
        pb["locked"] = True
        pb["step"] = "REFINE"
        return handle_plan_refine(state, user_text, topic_key)

    plan = build_plan_object(topic_key, pb.get("discovery_answers") or {}, user_text)

    # Save plan
    state["plans"][plan["id"]] = plan
    pb["active_plan_id"] = plan["id"]
    pb["locked"] = True
    pb["step"] = "REFINE"

    mermaid = plan_to_mermaid(plan)
    plan_link = f"/plans/{plan['id']}"  # frontend can interpret this route however you want

    coach_text = (
        f"Awesome — I made a starter plan for **{plan['title']}**.\n"
        f"Want it more intense or more lightweight?"
    )

    return ChatResponse(
        messages=[CoachMessage(text=coach_text)],
        ui=UIState(mode="PLAN_BUILD", show_plan_sidebar=True, plan_link=plan_link, mermaid=mermaid),
        effects=Effects(created_plan_id=plan["id"]),
        plan=plan,
    )


def handle_plan_refine(state: Dict[str, Any], user_text: str, topic_key: str) -> ChatResponse:
    pb = state["plan_build"]
    pb["topic"] = topic_key
    pb["step"] = "REFINE"

    plan_id = pb.get("active_plan_id")
    if not plan_id or plan_id not in state["plans"]:
        # If missing, fall back to draft
        pb["step"] = "DRAFT"
        pb["locked"] = False
        return handle_plan_draft(state, user_text, topic_key)

    plan = state["plans"][plan_id]

    # If user explicitly asks for a new plan, draft a replacement.
    if explicit_new_plan_request(user_text):
        pb["locked"] = False
        pb["step"] = "DRAFT"
        # Reset discovery for clean new plan (optional)
        pb["discovery_questions_asked"] = 0
        pb["discovery_answers"] = {}
        return handle_plan_draft(state, user_text, topic_key)

    # Otherwise, we refine in-place.
    system = (
        "You are editing an existing plan. Do NOT create a new plan. "
        "Given the user's request, propose up to 5 concrete edits to tasks. "
        "Return ONLY a bullet list of edits using one of these verbs at the start: "
        "'ADD:', 'REMOVE:', 'CHANGE:', 'REORDER:'."
    )
    user = (
        f"Plan title: {plan.get('title')}\n"
        f"Existing tasks:\n"
        + "\n".join([f"- {t['text']}" for t in (plan.get("tasks") or [])][:12])
        + "\n\nUser request:\n"
        + user_text
    )
    edits_raw = gemini_text(system, user)
    edits = extract_bullets(edits_raw, max_items=5)

    # Apply edits lightly/deterministically:
    tasks = plan.get("tasks") or []

    def add_task(text: str):
        if text and len(tasks) < 30:
            tasks.append({"text": text, "status": "todo"})

    def remove_match(text: str):
        # Remove first task that roughly matches
        key = text.lower().strip()
        for i, t in enumerate(tasks):
            if key and key in t.get("text", "").lower():
                tasks.pop(i)
                return

    def change_match(old_new: str):
        # naive "CHANGE: old -> new" parsing
        m = re.split(r"\s*->\s*", old_new, maxsplit=1)
        if len(m) != 2:
            return
        old, new = m[0].strip(), m[1].strip()
        if not old or not new:
            return
        for t in tasks:
            if old.lower() in t.get("text", "").lower():
                t["text"] = new
                return

    def reorder_hint(_text: str):
        # We keep reorder simple: move first matching to top
        key = _text.lower().strip()
        for i, t in enumerate(tasks):
            if key and key in t.get("text", "").lower():
                task = tasks.pop(i)
                tasks.insert(0, task)
                return

    for e in edits:
        e2 = e.strip()
        if e2.upper().startswith("ADD:"):
            add_task(e2[4:].strip())
        elif e2.upper().startswith("REMOVE:"):
            remove_match(e2[7:].strip())
        elif e2.upper().startswith("CHANGE:"):
            change_match(e2[7:].strip())
        elif e2.upper().startswith("REORDER:"):
            reorder_hint(e2[8:].strip())

    plan["tasks"] = tasks
    plan["updated_at"] = _now_iso()
    state["plans"][plan_id] = plan

    mermaid = plan_to_mermaid(plan)
    plan_link = f"/plans/{plan_id}"

    coach_text = (
        "Done — I updated your current plan (same plan, not a new one).\n"
        "What do you want to tackle *today*?"
    )

    return ChatResponse(
        messages=[CoachMessage(text=coach_text)],
        ui=UIState(mode="PLAN_BUILD", show_plan_sidebar=True, plan_link=plan_link, mermaid=mermaid),
        effects=Effects(updated_plan_id=plan_id),
        plan=plan,
    )


# ---------------------------
# Main endpoint
# ---------------------------
@router.post("", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    all_state = _load_all_state()
    bucket = _get_user_bucket(all_state, req.user_id)
    state = _ensure_state_shape(bucket)

    user_text = (req.message or "").strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="Empty message")

    # Append history
    state["history"].append({"role": "user", "text": user_text, "ts": _now_iso()})
    state["history"] = state["history"][-80:]  # cap

    # Topic
    topic_key = normalize_topic_key(req.topic) or infer_topic_key(user_text, req.profile)

    # Non-blocking confidence capture
    saved_conf = maybe_capture_confidence(state, user_text, topic_key)

    # Decide mode/step deterministically
    mode, step = decide_mode_and_step(state, user_text, topic_key)
    state["mode"] = mode

    # Enforce plan stability lock: if plan exists for topic and no explicit new plan -> REFINE
    pb = state["plan_build"]
    has_active_plan_same_topic = bool(pb.get("active_plan_id")) and pb.get("topic") == topic_key
    if mode == "PLAN_BUILD" and has_active_plan_same_topic and not explicit_new_plan_request(user_text):
        pb["locked"] = True
        step = "REFINE"

    # Route to handlers
    if mode == "CHAT":
        resp = handle_chat(state, user_text, topic_key, saved_conf)
    elif mode == "PLAN_BUILD":
        # If no plan exists, we do DISCOVERY (max 2 Qs), then DRAFT.
        if step == "DISCOVERY":
            resp = handle_plan_discovery(state, user_text, topic_key)
        elif step == "DRAFT":
            resp = handle_plan_draft(state, user_text, topic_key)
        else:
            resp = handle_plan_refine(state, user_text, topic_key)
    else:
        # CHECKIN reserved for later; fallback to CHAT now.
        state["mode"] = "CHAT"
        resp = handle_chat(state, user_text, topic_key, saved_conf)

    # Append coach message to history
    if resp.messages:
        state["history"].append({"role": "coach", "text": resp.messages[0].text, "ts": _now_iso()})
        state["history"] = state["history"][-80:]

    # Persist state
    bucket.clear()
    bucket.update(state)
    _save_all_state(all_state)

    return resp
