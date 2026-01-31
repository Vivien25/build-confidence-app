# backend/chat.py
import os
import json
import re
import traceback
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
import edge_tts
import uuid

# debug
from backend.debug_logger import log_debug

from google import genai
from google.genai import types

router = APIRouter(prefix="/chat", tags=["chat"])

# ===========================
# Gemini client
# ===========================
API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if not API_KEY:
    raise RuntimeError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) in backend/.env")

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
client = genai.Client(api_key=API_KEY)

# ===========================
# 12-hour follow-up config (Option B: in-app check-in)
# ===========================
FOLLOWUP_HOURS = int(os.getenv("FOLLOWUP_HOURS", "12"))

# ===========================
# Local Whisper (STT)
# ===========================
WHISPER_BACKEND = os.getenv("WHISPER_BACKEND", "faster")  # "faster" | "openai"
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")        # tiny/base/small/medium/large-v3
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")       # cpu | cuda
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

_whisper_ready = False
_whisper_impl = None
_whisper_model = None

def _init_whisper_if_needed() -> None:
    global _whisper_ready, _whisper_impl, _whisper_model
    if _whisper_ready:
        return

    try:
        if WHISPER_BACKEND.lower() == "openai":
            import whisper  # type: ignore
            _whisper_impl = "openai"
            _whisper_model = whisper.load_model(WHISPER_MODEL)
        else:
            from faster_whisper import WhisperModel  # type: ignore
            _whisper_impl = "faster"
            _whisper_model = WhisperModel(
                WHISPER_MODEL,
                device=WHISPER_DEVICE,
                compute_type=WHISPER_COMPUTE_TYPE,
            )

        _whisper_ready = True
        print(f"✅ Whisper ready: impl={_whisper_impl} model={WHISPER_MODEL}")
    except Exception as e:
        print("❌ Whisper init failed:", repr(e))
        traceback.print_exc()
        _whisper_ready = False
        _whisper_impl = None
        _whisper_model = None

def transcribe_audio_file(path: str) -> str:
    _init_whisper_if_needed()
    if not _whisper_ready or _whisper_model is None:
        raise HTTPException(
            status_code=500,
            detail="Whisper is not available on the server. Install faster-whisper or openai-whisper (and ffmpeg).",
        )

    try:
        if _whisper_impl == "openai":
            # openai-whisper
            # result = {"text": "...", ...}
            result = _whisper_model.transcribe(path)  # type: ignore
            text = (result.get("text") or "").strip()
            return text

        segments, info = _whisper_model.transcribe(path)  # type: ignore
        parts = []
        for seg in segments:
            t = getattr(seg, "text", "") or ""
            if t.strip():
                parts.append(t.strip())
        return " ".join(parts).strip()

    except Exception as e:
        print("❌ Whisper transcription failed:", repr(e))
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Whisper transcription error: {repr(e)}")

# ===========================
# Tiny JSON-file state store
# ===========================
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = DATA_DIR / "user_state.json"

def _now() -> datetime:
    return datetime.now(timezone.utc)

def _now_iso() -> str:
    return _now().isoformat()

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

# ===========================
# Request / Response models
# ===========================
class ChatRequest(BaseModel):
    user_id: str = Field(..., description="Stable id (email, uuid, etc.)")
    message: str = Field(..., description="User message text")
    coach: Optional[str] = None
    profile: Optional[Dict[str, Any]] = None
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

class VoiceChatResponse(BaseModel):
    transcript: str
    chat: ChatResponse


class HistoryMessage(BaseModel):
    role: str
    text: str
    ts: str
    kind: Optional[str] = None


class HistoryResponse(BaseModel):
    topic: str
    messages: List[HistoryMessage]

# ===========================
# State schema
# ===========================
DEFAULT_STATE = {
    "mode": "CHAT",
    "history": [],  # list[{role,text,ts,kind?}]
    "metrics": {"confidence": {}},
    "plan_build": {
        "step": "DISCOVERY",
        "topic": None,
        "discovery_questions_asked": 0,
        "discovery_answers": {},
        "active_plan_id": None,
        "locked": False,
    },
    "plans": {},

    # ✅ NEW: follow-up tracking (Option B: in-app check-in)
    "followup": {
        "pending_at": None,         # ISO UTC
        "pending_for_ts": None,     # user message ts that scheduled this check-in
        "last_sent_at": None,       # ISO UTC
    },
}

def _ensure_state_shape(state: Dict[str, Any]) -> Dict[str, Any]:
    merged = json.loads(json.dumps(DEFAULT_STATE))
    for k, v in state.items():
        merged[k] = v

    merged.setdefault("history", [])
    merged.setdefault("metrics", {"confidence": {}})
    merged["metrics"].setdefault("confidence", {})
    merged.setdefault("plan_build", {})
    for k, v in DEFAULT_STATE["plan_build"].items():
        merged["plan_build"].setdefault(k, v)
    merged.setdefault("plans", {})
    merged.setdefault("followup", {})
    for k, v in DEFAULT_STATE["followup"].items():
        merged["followup"].setdefault(k, v)

    # normalize older history rows (kind missing)
    for m in merged.get("history", []):
        if isinstance(m, dict):
            m.setdefault("kind", None)

    return merged

# ===========================
# Intent / Topic router
# ===========================
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
    r"\brevise\b",
]
_SKIP_PATTERNS = [
    r"\bskip\b",
    r"\bjust chat\b",
    r"\bno plan\b",
    r"\bstop\b",
    r"\bnot now\b",
]
_SHOW_PLAN_PATTERNS = [
    r"\bshow (me )?the plan\b",
    r"\bsee the plan\b",
    r"\bview the plan\b",
    r"\bopen the plan\b",
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

def show_plan_requested(user_text: str) -> bool:
    return _matches_any(user_text, _SHOW_PLAN_PATTERNS)

def normalize_topic_key(topic: Optional[str]) -> Optional[str]:
    if not topic:
        return None
    t = topic.strip().lower()
    t = re.sub(r"[^a-z0-9_]+", "_", t)
    t = re.sub(r"_+", "_", t).strip("_")
    return t or None

def infer_topic_key(user_text: str, profile: Optional[Dict[str, Any]] = None) -> str:
    t = (user_text or "").lower()

    if any(k in t for k in ["interview", "behavioral", "system design", "leetcode", "ml ops", "mle", "data engineer"]):
        return "interview_confidence"
    if any(k in t for k in ["work", "job", "boss", "coworker", "deadline", "productivity", "focus"]):
        return "work_focus"
    if any(k in t for k in ["relationship", "partner", "husband", "wife", "dating", "communication"]):
        return "relationship_communication"
    if any(k in t for k in ["appearance", "body image", "looks", "weight", "skin", "hair"]):
        return "appearance_confidence"

    if profile and isinstance(profile, dict):
        focus = str(profile.get("focus") or "").lower()
        if focus:
            return normalize_topic_key(focus) or "general"

    return "general"

# ===========================
# Deterministic mode router
# ===========================
DISCOVERY_QUESTIONS = [
    "When is the deadline (or when do you want to feel ready)? If you’re not sure, just say “soon.”",
    "What’s the main target: ML Ops / Data Engineering / both? (One word is fine.)",
]

def decide_mode_and_step(state: Dict[str, Any], user_text: str, topic_key: str) -> Tuple[str, Optional[str]]:
    if skip_requested(user_text):
        return "CHAT", None

    pb = state["plan_build"]
    has_active_plan = bool(pb.get("active_plan_id")) and pb.get("topic") == topic_key

    if explicit_new_plan_request(user_text):
        return "PLAN_BUILD", "DRAFT"

    if refine_requested(user_text) and has_active_plan:
        return "PLAN_BUILD", "REFINE"

    if plan_requested(user_text):
        if has_active_plan:
            return "CHAT", None
        return "PLAN_BUILD", "DISCOVERY"

    if state.get("mode") == "PLAN_BUILD":
        if pb.get("step") == "DISCOVERY" and (pb.get("discovery_questions_asked") or 0) < len(DISCOVERY_QUESTIONS):
            return "PLAN_BUILD", "DISCOVERY"

    return "CHAT", None

# ===========================
# Plan lock rule
# ===========================
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

# ===========================
# Learning resources
# ===========================
RESOURCE_CATALOG: Dict[str, List[Dict[str, str]]] = {
    "mlops": [
        {
            "title": "Google Cloud: MLOps (CD/CT pipelines) overview",
            "url": "https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning",
            "type": "doc",
        },
        {
            "title": "Vertex AI: MLOps & pipelines (overview)",
            "url": "https://cloud.google.com/vertex-ai/docs/pipelines/introduction",
            "type": "doc",
        },
        {"title": "MLflow Tracking (official docs)", "url": "https://mlflow.org/docs/latest/tracking.html", "type": "doc"},
        {"title": "Model monitoring concepts (Vertex AI)", "url": "https://cloud.google.com/vertex-ai/docs/model-monitoring/overview", "type": "doc"},
    ],
    "system_design": [
        {"title": "Google Cloud Architecture Center", "url": "https://cloud.google.com/architecture", "type": "doc"},
        {"title": "Google SRE Workbook (reliability patterns)", "url": "https://sre.google/workbook/table-of-contents/", "type": "book"},
    ],
    "data_engineering": [
        {"title": "BigQuery documentation", "url": "https://cloud.google.com/bigquery/docs", "type": "doc"},
        {"title": "BigQuery best practices", "url": "https://cloud.google.com/bigquery/docs/best-practices-performance-overview", "type": "doc"},
        {"title": "Cloud Storage documentation", "url": "https://cloud.google.com/storage/docs", "type": "doc"},
    ],
    "kubernetes": [
        {"title": "Kubernetes Basics", "url": "https://kubernetes.io/docs/tutorials/kubernetes-basics/", "type": "doc"},
        {"title": "Kubernetes Deployments", "url": "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/", "type": "doc"},
    ],
    "interview": [
        {"title": "STAR interview method (overview)", "url": "https://en.wikipedia.org/wiki/Situation,_task,_action,_result", "type": "article"},
        {"title": "System design primer (GitHub)", "url": "https://github.com/donnemartin/system-design-primer", "type": "repo"},
    ],
}

def pick_resources(topic_key: str, task_text: str, max_items: int = 3) -> List[Dict[str, str]]:
    t = (task_text or "").lower()
    picks: List[Dict[str, str]] = []

    if any(k in t for k in ["mlops", "pipeline", "deployment", "serving", "monitor", "drift", "registry", "version"]):
        picks += RESOURCE_CATALOG["mlops"]
    if any(k in t for k in ["bigquery", "sql", "etl", "elt", "warehouse", "dataflow", "spark", "composer", "airflow", "gcs", "storage"]):
        picks += RESOURCE_CATALOG["data_engineering"]
    if any(k in t for k in ["system design", "architecture", "trade-off", "latency", "throughput", "reliability", "scalability"]):
        picks += RESOURCE_CATALOG["system_design"]
    if any(k in t for k in ["k8s", "kubernetes", "helm", "pod", "service mesh"]):
        picks += RESOURCE_CATALOG["kubernetes"]
    if any(k in t for k in ["behavioral", "star", "mock interview", "interview", "tell me about yourself"]):
        picks += RESOURCE_CATALOG["interview"]

    if not picks and topic_key == "interview_confidence":
        picks += RESOURCE_CATALOG["interview"] + RESOURCE_CATALOG["system_design"] + RESOURCE_CATALOG["mlops"]

    seen = set()
    out: List[Dict[str, str]] = []
    for r in picks:
        url = r.get("url")
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(r)
        if len(out) >= max_items:
            break
    return out

# ===========================
# Follow-up (Option B): schedule + inject check-in message
# ===========================
def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _schedule_followup(state: Dict[str, Any]) -> None:
    """
    Schedule a check-in FOLLOWUP_HOURS from now, tied to the last user message ts.
    """
    fu = state.setdefault("followup", {})
    now = _now()
    fu["pending_at"] = (now + timedelta(hours=FOLLOWUP_HOURS)).isoformat()

    last_user = next((m for m in reversed(state.get("history", [])) if m.get("role") == "user"), None)
    fu["pending_for_ts"] = last_user.get("ts") if isinstance(last_user, dict) else None


def _inject_due_followup_if_needed(state: Dict[str, Any], coach_id: Optional[str], topic_key: str) -> bool:
    """
    If pending follow-up time is due AND user hasn't sent a new message since it was scheduled,
    inject a coach message into history. Returns True if injected.
    """
    fu = state.get("followup") or {}
    pending_at = _parse_iso(fu.get("pending_at"))
    pending_for_ts = fu.get("pending_for_ts")

    if not pending_at or not pending_for_ts:
        return False

    if _now() < pending_at:
        return False

    # If user sent a new message since scheduling, skip this follow-up
    last_user = next((m for m in reversed(state.get("history", [])) if m.get("role") == "user"), None)
    if not last_user or last_user.get("ts") != pending_for_ts:
        fu["pending_at"] = None
        fu["pending_for_ts"] = None
        state["followup"] = fu
        return False

    coach_name = "Kai" if (coach_id or "").lower().strip() in ["kai", "male", "coach_kai"] else "Mira"
    msg = (
        f"Quick check-in 🌱 It’s been about {FOLLOWUP_HOURS} hours.\n"
        f"How did it go on **{topic_key.replace('_', ' ')}**?\n"
        "Tell me one thing you did (even small), and one thing that felt hard."
    )

    state.setdefault("history", []).append(
        {"role": "coach", "text": msg, "ts": _now_iso(), "kind": "checkin_12h"}
    )
    state["history"] = state["history"][-120:]

    fu["last_sent_at"] = _now_iso()
    fu["pending_at"] = None
    fu["pending_for_ts"] = None
    state["followup"] = fu
    return True

# ===========================
# Gemini helpers
# ===========================
# ===========================
# Gemini helpers (with Fallback)
# ===========================
# Verified available models from API:
# - gemini-2.5-flash
# - gemini-2.5-pro
# - gemini-2.0-flash

MODEL_PREFERENCE = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
]

def gemini_text(system: str, user: str) -> str:
    # Try models in order
    last_error = None
    
    # Prepend the requested env model if it's different and valid
    candidates = list(MODEL_PREFERENCE)
    if GEMINI_MODEL and GEMINI_MODEL not in candidates:
        candidates.insert(0, GEMINI_MODEL)

    for model_name in candidates:
        try:
            log_debug(f"🤖 Calling Gemini with model: {model_name}")
            resp = client.models.generate_content(
                model=model_name,
                contents=[
                    types.Content(
                        role="user",
                        parts=[types.Part(text=f"{system}\n\nUSER:\n{user}")]
                    )
                ],
                config=types.GenerateContentConfig(temperature=0.7, max_output_tokens=700),
            )
            text = getattr(resp, "text", None)
            if text:
                return text.strip()
            
            # Check candidates
            if getattr(resp, "candidates", None):
                parts = resp.candidates[0].content.parts
                return "".join([p.text for p in parts if getattr(p, "text", None)]).strip()
            
            # If we got here, empty response but no exception? treat as failure to fallback
            log_debug(f"⚠️ Empty response from {model_name}, trying next...")
            
        except Exception as e:
            log_debug(f"⚠️ Model {model_name} failed: {repr(e)}")
            last_error = e
            # continue loop
            
    # If all failed
    log_debug("❌ ALL GEMINI MODELS FAILED")
    raise HTTPException(status_code=500, detail=f"Gemini error (all models failed): {repr(last_error)}")

# ... (rest of file) ...

# ===========================
# Voice endpoint (audio -> whisper -> chat)
# ===========================

def transcribe_with_gemini(path: str, mime_type: str = "audio/webm") -> str:
    """Fallback STT using Gemini 2.0 Flash (multimodal) or 1.5 family"""
    # Start with the configured model (e.g. gemini-3-flash-preview)
    models_to_try = []
    if GEMINI_MODEL:
        models_to_try.append(GEMINI_MODEL)
        
    # Add robust fallbacks
    models_to_try.extend([
        "gemini-2.5-flash", 
        "gemini-2.0-flash", 
        "gemini-1.5-flash"
    ])
    
    # Deduplicate in case GEMINI_MODEL is one of the defaults
    models_to_try = list(dict.fromkeys(models_to_try))
    
    with open(path, "rb") as f:
        audio_data = f.read()
    
    # Ensure mime_type is valid for Gemini. 
    log_debug(f"🎤 Transcribing {len(audio_data)} bytes type={mime_type}...")

    last_err = None
    for m in models_to_try:
        try:
            log_debug(f"   Attempts using model={m}...")
            resp = client.models.generate_content(
                model=m,
                contents=[
                    types.Content(
                    role="user",
                    parts=[
                        types.Part.from_bytes(data=audio_data, mime_type=mime_type),
                        types.Part(text="Transcribe this audio verbatim. Output ONLY the transcription text. If no speech, output nothing.")
                    ]
                )],
                config=types.GenerateContentConfig(temperature=0.0)
            )
            text = (resp.text or "").strip()
            if text:
                return text
        except Exception as e:
            log_debug(f"   ❌ Failed with {m}: {e}")
            last_err = e
            
    log_debug(f"❌ All Gemini STT models failed. Last error: {last_err}")
    return ""

@router.get("/debug/ping-gemini")
def ping_gemini():
    txt = gemini_text("Reply with exactly the word OK.", "ping")
    return {"ok": True, "model": GEMINI_MODEL, "reply": txt}

def extract_bullets(text: str, max_items: int = 10) -> List[str]:
    lines = [ln.strip() for ln in (text or "").splitlines()]
    bullets: List[str] = []
    for ln in lines:
        ln = re.sub(r"^\s*[-*•]\s+", "", ln).strip()
        ln = re.sub(r"^\s*\d+\.\s+", "", ln).strip()
        if not ln:
            continue
        if len(ln) > 160:
            ln = ln[:157].rstrip() + "…"
        bullets.append(ln)
        if len(bullets) >= max_items:
            break
    return bullets

# ===========================
# Confidence: non-blocking metadata
# ===========================
def maybe_capture_confidence(state: Dict[str, Any], user_text: str, topic_key: str) -> bool:
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

# ===========================
# Plan building primitives
# ===========================
def build_plan_object(topic_key: str, discovery_answers: Dict[str, Any], user_text: str) -> Dict[str, Any]:
    deadline = discovery_answers.get("deadline") or "soon"
    target = discovery_answers.get("target") or "mixed"

    system = (
        "You are a practical, concise coach. Suggest a simple plan. "
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
    task_texts = extract_bullets(ideas, max_items=10)

    if not task_texts:
        task_texts = [
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

    tasks = []
    for t in task_texts:
        tasks.append({"text": t, "status": "todo", "resources": pick_resources(topic_key, t, max_items=3)})

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
        "tasks": tasks,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    return plan

def plan_to_mermaid(plan: Dict[str, Any]) -> str:
    title = (plan.get("title") or "Plan").replace('"', "'")
    tasks = plan.get("tasks") or []
    nodes = tasks[:6]
    lines = ["flowchart TD", f'A["{title}"]']
    for i, t in enumerate(nodes, start=1):
        txt = (t.get("text") or "").replace('"', "'")
        node_id = f"T{i}"
        lines.append(f'{node_id}["{txt}"]')
        lines.append(f"A --> {node_id}")
    return "\n".join(lines)

# ===========================
# Mode handlers
# ===========================
# ===========================
# Handover & Context
# ===========================
def _get_coach_transition_context(state: Dict[str, Any], current_coach_name: str) -> str:
    """
    Check if the user has switched coaches since the last interaction.
    Returns a context string for the system prompt if a switch occurred.
    """
    meta = state.setdefault("metadata", {})
    last_coach = meta.get("last_coach_name")
    
    # Update for next time
    meta["last_coach_name"] = current_coach_name
    
    if last_coach and last_coach.lower() != current_coach_name.lower():
        return (
            f"CONTEXT: The user was previously coached by 'Coach {last_coach}'. "
            f"You are now 'Coach {current_coach_name}'. "
            f"The user has an existing plan. "
            "CRITICAL: You MUST acknowledge this transition immediately. "
            f"Say something like: 'I see you started this plan with my colleague Coach {last_coach}. "
            "I'm here to help you continue that progress without interruption.' "
            "Ensure them that their plan is safe and you are up to speed.\n"
        )
    return ""

def _build_system_prompt(
    state: Dict[str, Any], 
    profile: Dict[str, Any], 
    coach_name: str, 
    topic_key: str, 
    transition_context: str
) -> str:
    first_name = profile.get("name", "Friend").split()[0]
    focus = profile.get("focus", "work")
    
    # Check if there's an active plan
    pb = state["plan_build"]
    active_plan_id = pb.get("active_plan_id")
    current_plan_summary = "None"
    if active_plan_id and active_plan_id in state["plans"]:
        p = state["plans"][active_plan_id]
        tasks = [t["text"] for t in p.get("tasks", [])[:3]]
        current_plan_summary = f"Title: {p.get('title')}, Goal: {p.get('goal')}, Top tasks: {'; '.join(tasks)}"

    # Context signals
    # We can infer 'returning moment' if it's been > X hours, but for now we'll rely on recent history length
    history = state.get("history", [])
    is_returning_moment = len(history) > 0 and (datetime.fromisoformat(_now_iso()) - datetime.fromisoformat(history[-1]["ts"])).total_seconds() > 3600 * 6
    
    # Helper to guess if plan switched recently (simple heuristic)
    plan_switched = False # Placeholder logic

    prompt = (
        f"CORE MISSION: Your primary goal is to build the user's CONFIDENCE. Speak to {first_name} directly by first name occasionally.\n"
        f"You are Coach {coach_name}, an expert life coach and empathetic friend.\n"
        "1. ADAPT YOUR ROLE based on the User's focus:\n"
        "   - If focus='work': Be a supportive Career & Leadership Coach.\n"
        "   - If focus='social': Be a Social Confidence & Connection Expert.\n"
        "   - Always maintain a warm, 'human' tone (no robotic summaries).\n"
        "2. THE CONFIDENCE-FIRST PROTOCOL:\n"
        "   - **Initial Assessment**: When a user shares a new concern or challenge, your first priority is to understand their mindset. ASK: 'On a scale of 1-10, how confident do you feel about handling this right now?'\n"
        "   - **Periodic Check-ins**: If the user is working on a plan, ask about their confidence level regularly to see if the steps are helping or causing overwhelm.\n"
        "   - **ADAPTIVE PACING**: Automatically adjust current plan steps in your 'plan' output based on feedback:\n"
        "     - If confidence is LOW (<5) or user feels overwhelmed: Simplify the next steps into tiny, microscopic wins. Reduce the 'pace'.\n"
        "     - If confidence is HIGH (>8): Challenge them more. Increase the 'pace' or add a growth-oriented goal.\n"
        "3. PLAN CREATION & DURATION (CRITICAL):\n"
        "   - **NEVER** output a 'plan' array in your JSON until the user has EXPLICITLY agreed to a specific duration (e.g., 'Yes, let's do 3 days').\n"
        "   - If the user has NOT agreed to a duration yet, your 'plan' array MUST be empty [].\n"
        "   - Instead, Ask: 'How long do you think we should focus on this? Maybe 3 days for a quick win, or a week for deeper habit building?'\n"
        "   - **NO REPETITION**: Do not show the same plan steps again if the user is asking a question or negotiating details. Only show the plan when it is finalized or explicitly requested.\n"
        "   - **FORMATTING**: If a plan is agreed (e.g. 7 days), provide exactly 7 strings in the 'plan' array.\n"
        "     - Each string must be a COMPLETE instruction (e.g. 'Day 1: Journal for 5 mins').\n"
        "     - Do NOT truncate sentences. Keep them short but complete.\n"
        "4. RETURNING USER / PLAN SWITCH PROTOCOL:\n"
        "   - If the user is returning after a break or has just switched to this plan:\n"
        "     - **Step 1 (Brief Check-in Check)**: Briefly acknowledge the previous topic/plan if one existed (e.g., 'Moving from work to social...').\n"
        "     - **Step 2 (Pivot to New)**:  Immediately shift focus to the NEW topic. Ask: 'What's on your mind regarding [New Focus] today?' or 'How are you feeling about [New Focus]?'\n"
        "     - Do NOT linger on the old plan. The user changed topics for a reason. Prioritize the new path.\n"
        "5. TONE & EMPATHY:\n"
        "   - Use 'empathy statements' to validate feelings (e.g., 'It's completely normal to feel that way').\n"
        "   - Focus on 'Process over Outcome' - celebrate the courage to try.\n"
        "6. RULES & OUTPUT:\n"
        "   - Return ONLY raw JSON (no markdown, no backticks).\n"
        "   - JSON keys: mode ('chat'/'coach'), message (empathetic reply), tips (0-3 strings), plan (0-5 steps), question (guiding next step), options (2-3 clickable path strings).\n"
        "   - **NO CLOSED STATEMENTS**: Every message must lead to the next step or a reflective question.\n"
        "   - **OPTIONS**: Always provide 2-3 short clickable paths. Always include one path like 'Something else...' or 'Tell me more'.\n"
        "\n"
        "Context for this turn:\n"
        f"- User focus: {focus}\n"
        f"- Current plan: {current_plan_summary}\n"
        f"- Returning moment? {'YES' if is_returning_moment else 'NO'}\n"
        f"- Just switched to this plan? {'YES' if plan_switched else 'NO'}\n"
        f"{transition_context}\n"
        "\n"
        "FINAL REMINDER: Confidence is the metric. Adjust the pace to fit the user. End with a question or option."
    )
    return prompt

def handle_chat(state: Dict[str, Any], user_text: str, topic_key: str, saved_conf: bool, coach_id: Optional[str], profile: Optional[Dict[str, Any]] = None) -> ChatResponse:
    # 1. Determine Coach Name
    coach_name = "Mira"
    if (coach_id or "").lower() in ["kai", "male", "coach_kai"]:
        coach_name = "Kai"
    
    # 2. Transition Logic
    transition_context = _get_coach_transition_context(state, coach_name)
    
    # 3. Build System Prompt
    profile = profile or {}
    system = _build_system_prompt(state, profile, coach_name, topic_key, transition_context)

    # 4. Construct User Message
    user_input = user_text
    if saved_conf:
        user_input += f"\n(Meta: User just updated confidence score for {topic_key})"

    # 5. Call Gemini
    raw_response = gemini_text(system, user_input)
    
    # 6. Parse JSON Response
    response_data = {}
    try:
        # cleanup if it returns markdown code blocks
        clean_json = raw_response.replace("```json", "").replace("```", "").strip()
        response_data = json.loads(clean_json)
    except Exception:
        print("❌ Failed to parse JSON from Gemini. Fallback to text.")
        response_data = {
            "mode": "chat",
            "message": raw_response,
            "options": ["Tell me more", "I'm not sure"]
        }

    # 7. Extract Fields
    message_text = response_data.get("message", "")
    question_text = response_data.get("question", "")
    full_text = f"{message_text}\n\n{question_text}".strip()
    
    # 8. Handle Plan Updates (if any)
    plan_obj = None
    plan_steps = response_data.get("plan", [])
    if isinstance(plan_steps, list) and len(plan_steps) > 0:
        # Create or update plan
        plan_id = f"plan_{uuid4().hex[:8]}"
        plan_obj = {
            "id": plan_id,
            "topic": topic_key,
            "title": f"Plan for {topic_key}",
            "goal": "Build confidence step by step",
            "tasks": [{"text": step, "status": "todo"} for step in plan_steps],
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        state["plans"][plan_id] = plan_obj
        state["plan_build"]["active_plan_id"] = plan_id
        state["plan_build"]["topic"] = topic_key
    
    # 9. Construct Response
    # The frontend expects 'messages' list. We merge message + question + options.
    # Note: The current frontend likely doesn't render 'options' natively from JSON yet, 
    # so we append them as text or just let them be part of the text. 
    # For now, we mainly return the text. 
    
    # We can append options to text if frontend doesn't support them to ensure they are visible
    options = response_data.get("options", [])
    if options:
       pass # Frontend doesn't explicitly render these from backend yet in ChatResponse, so we rely on text.

    return ChatResponse(
        messages=[CoachMessage(text=full_text)],
        ui=UIState(
            mode=response_data.get("mode", "CHAT").upper(), 
            show_plan_sidebar=bool(plan_obj), 
            plan_link=f"/plans/{plan_obj['id']}" if plan_obj else None,
            mermaid=plan_to_mermaid(plan_obj) if plan_obj else None
        ),
        effects=Effects(saved_confidence=saved_conf),
        plan=plan_obj,
    )

def handle_plan_discovery(state: Dict[str, Any], user_text: str, topic_key: str) -> ChatResponse:
    pb = state["plan_build"]
    pb["topic"] = topic_key
    pb["step"] = "DISCOVERY"

    q_asked = int(pb.get("discovery_questions_asked") or 0)
    if q_asked > 0:
        idx = q_asked - 1
        if idx == 0:
            pb["discovery_answers"]["deadline"] = user_text.strip()
        elif idx == 1:
            pb["discovery_answers"]["target"] = user_text.strip()

    if q_asked >= len(DISCOVERY_QUESTIONS):
        pb["step"] = "DRAFT"
        return handle_plan_draft(state, user_text, topic_key)

    question = DISCOVERY_QUESTIONS[q_asked]
    pb["discovery_questions_asked"] = q_asked + 1

    state["mode"] = "PLAN_BUILD"
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

    if not should_create_new_plan(state, user_text, topic_key):
        pb["locked"] = True
        state["mode"] = "CHAT"
        active_id = pb.get("active_plan_id")
        plan = state["plans"].get(active_id) if active_id else None
        return ChatResponse(
            messages=[CoachMessage(text="You already have a plan for this topic. Want to work on step 1 or revise anything?")],
            ui=UIState(
                mode="CHAT",
                show_plan_sidebar=True,
                plan_link=(f"/plans/{active_id}" if active_id else None),
                mermaid=(plan_to_mermaid(plan) if plan else None),
            ),
            effects=Effects(),
            plan=None,
        )

    plan = build_plan_object(topic_key, pb.get("discovery_answers") or {}, user_text)

    state["plans"][plan["id"]] = plan
    pb["active_plan_id"] = plan["id"]
    pb["locked"] = True
    pb["step"] = "REFINE"

    mermaid = plan_to_mermaid(plan)
    plan_link = f"/plans/{plan['id']}"

    coach_text = (
        f"Awesome — I made a starter plan for **{plan['title']}**.\n"
        "I also attached learning resources under each step so you can implement right away.\n"
        "Want it more intense or more lightweight?"
    )

    state["mode"] = "CHAT"

    return ChatResponse(
        messages=[CoachMessage(text=coach_text)],
        ui=UIState(mode="CHAT", show_plan_sidebar=True, plan_link=plan_link, mermaid=mermaid),
        effects=Effects(created_plan_id=plan["id"]),
        plan=plan,
    )

def handle_plan_refine(state: Dict[str, Any], user_text: str, topic_key: str) -> ChatResponse:
    pb = state["plan_build"]
    pb["topic"] = topic_key
    pb["step"] = "REFINE"

    plan_id = pb.get("active_plan_id")
    if not plan_id or plan_id not in state["plans"]:
        pb["step"] = "DRAFT"
        pb["locked"] = False
        return handle_plan_draft(state, user_text, topic_key)

    plan = state["plans"][plan_id]

    if explicit_new_plan_request(user_text):
        pb["locked"] = False
        pb["step"] = "DRAFT"
        pb["discovery_questions_asked"] = 0
        pb["discovery_answers"] = {}
        return handle_plan_draft(state, user_text, topic_key)

    if not refine_requested(user_text):
        state["mode"] = "CHAT"
        return ChatResponse(
            messages=[CoachMessage(text="Got it. Which step do you want to tackle today?")],
            ui=UIState(mode="CHAT", show_plan_sidebar=True, plan_link=f"/plans/{plan_id}", mermaid=plan_to_mermaid(plan)),
            effects=Effects(),
            plan=None,
        )

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

    tasks = plan.get("tasks") or []

    def add_task(text: str):
        if text and len(tasks) < 30:
            tasks.append({"text": text, "status": "todo", "resources": pick_resources(topic_key, text)})

    def remove_match(text: str):
        key = text.lower().strip()
        for i, t in enumerate(tasks):
            if key and key in t.get("text", "").lower():
                tasks.pop(i)
                return

    def change_match(old_new: str):
        m = re.split(r"\s*->\s*", old_new, maxsplit=1)
        if len(m) != 2:
            return
        old, new = m[0].strip(), m[1].strip()
        if not old or not new:
            return
        for t in tasks:
            if old.lower() in t.get("text", "").lower():
                t["text"] = new
                t["resources"] = pick_resources(topic_key, new)
                return

    def reorder_hint(_text: str):
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

    coach_text = (
        "Done — I updated your current plan (same plan, not a new one).\n"
        "Resources are attached under steps. What do you want to tackle *today*?"
    )

    state["mode"] = "CHAT"

    return ChatResponse(
        messages=[CoachMessage(text=coach_text)],
        ui=UIState(mode="CHAT", show_plan_sidebar=True, plan_link=f"/plans/{plan_id}", mermaid=plan_to_mermaid(plan)),
        effects=Effects(updated_plan_id=plan_id),
        plan=plan,
    )

# ===========================
# Core processing (shared)
# ===========================
@router.post("", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest):
    # Load state
    all_state = _load_all_state()
    user_state = _get_user_bucket(all_state, req.user_id)
    user_state = _ensure_state_shape(user_state)

    # Detect confidence input
    saved_conf = False
    if req.topic:
        topic_key = normalize_topic_key(req.topic)
        if topic_key and maybe_capture_confidence(user_state, req.message, topic_key):
            saved_conf = True

    # Current topic
    topic_key = normalize_topic_key(req.topic) or user_state["plan_build"].get("topic") or "general"
    if req.profile:
        # if user context implies a different topic, maybe switch?
        # for now rely on req.topic
        pass

    # Basic history update
    user_state["history"].append({"role": "user", "text": req.message, "ts": _now_iso()})
    
    # Check follow-up injection (Option B)
    injected_fu = _inject_due_followup_if_needed(user_state, req.coach, topic_key)
    if injected_fu:
        # if we injected a message, the user hasn't seen it yet, 
        # but technically they just replied. 
        # This logic is tricky in a single turn. 
        # If the user is replying to a *previous* session, we just proceed.
        pass

    # Route
    mode, step = decide_mode_and_step(user_state, req.message, topic_key)
    user_state["mode"] = mode
    if step:
        user_state["plan_build"]["step"] = step

    # Execute
    if mode == "PLAN_BUILD":
        if step == "DISCOVERY":
            resp = handle_plan_discovery(user_state, req.message, topic_key)
        elif step == "DRAFT":
            resp = handle_plan_draft(user_state, req.message, topic_key)
        else: # REFINE
            resp = handle_plan_refine(user_state, req.message, topic_key)
    else:
        resp = handle_chat(user_state, req.message, topic_key, saved_conf, req.coach, req.profile)

    # Save coach msg to history
    for m in resp.messages:
        user_state["history"].append({"role": "assistant", "text": m.text, "ts": _now_iso()})

    # Keep history bounded
    user_state["history"] = user_state["history"][-60:]

    # Schedule next follow-up
    _schedule_followup(user_state)

    # Save
    _save_all_state(all_state)

    return resp

# ===========================
# History endpoint (Option B)
# ===========================
@router.get("/history", response_model=HistoryResponse)
def get_history(user_id: str, topic: Optional[str] = None, coach: Optional[str] = None):
    all_state = _load_all_state()
    user_state = _get_user_bucket(all_state, user_id)
    user_state = _ensure_state_shape(user_state)

    # We could filter by topic if we stored topic per message, 
    # but for now we return the global conversation or just last N.
    # To support context handover, we might verify if last message was from a different coach.
    
    # Check handover
    current_coach = (coach or "").strip()
    if current_coach:
        _get_coach_transition_context(user_state, current_coach) # updates metadata
        _save_all_state(all_state)

    hist = [
        HistoryMessage(
            role=m["role"],
            text=m["text"],
            ts=m.get("ts") or _now_iso(),
            kind=m.get("kind")
        )
        for m in user_state["history"]
    ]
    
    return HistoryResponse(
        topic=topic or "general",
        messages=hist
    )

# ===========================
# Voice endpoint (audio -> whisper -> chat)
# ===========================

def transcribe_with_gemini(path: str, mime_type: str = "audio/webm") -> str:
    """Fallback STT using Gemini 1.5 Flash (stable) or 2.0 Flash"""
    # 1.5 Flash is often more stable for general audio API usage than exp
    models_to_try = ["gemini-1.5-flash", "gemini-2.0-flash-exp"]
    
    with open(path, "rb") as f:
        audio_data = f.read()
    
    # Ensure mime_type is valid for Gemini. 
    # Valid: audio/wav, audio/mp3, audio/aiff, audio/aac, audio/ogg, audio/flac, audio/webm, audio/mpeg
    print(f"🎤 Transcribing {len(audio_data)} bytes type={mime_type}...")

    last_err = None
    for m in models_to_try:
        try:
            print(f"   Attempts using model={m}...")
            resp = client.models.generate_content(
                model=m,
                contents=[
                    types.Content(
                    role="user",
                    parts=[
                        types.Part.from_bytes(data=audio_data, mime_type=mime_type),
                        types.Part(text="Transcribe this audio verbatim. Output ONLY the transcription text. If no speech, output nothing.")
                    ]
                )],
                config=types.GenerateContentConfig(temperature=0.0)
            )
            text = (resp.text or "").strip()
            if text:
                return text
        except Exception as e:
            print(f"   ❌ Failed with {m}: {e}")
            last_err = e
            
    print(f"❌ All Gemini STT models failed. Last error: {last_err}")
    return ""

@router.post("/voice", response_model=VoiceChatResponse)
async def chat_voice(
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    coach: Optional[str] = Form(None),
    topic: Optional[str] = Form(None),
    profile_json: Optional[str] = Form(None),
) -> VoiceChatResponse:
    log_debug(f"🎤 ENTRY chat_voice: user_id={user_id} file={audio.filename} type={audio.content_type} size={audio.size}")
    
    # default to uploaded content type, or fallback to webm
    mime = audio.content_type or "audio/webm"
    if "octet-stream" in mime: 
        mime = "audio/webm" # browsers sometimes send octet-stream for blobs

    profile: Optional[Dict[str, Any]] = None
    if profile_json:
        try:
            profile = json.loads(profile_json)
        except Exception as e:
            log_debug(f"⚠️ profile_json parse failed: {e}")
            profile = None

    suffix = ""
    try:
        name = (audio.filename or "").lower()
        if "." in name:
            suffix = "." + name.split(".")[-1]
    except Exception:
        suffix = ""
        
    # Map common suffix to mime if mime is generic
    if suffix == ".mp3": mime = "audio/mp3"
    if suffix == ".wav": mime = "audio/wav"

    tmp_path = None
    try:
        # Save to temp
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or ".webm") as tmp:
            tmp_path = tmp.name
            content = await audio.read()
            tmp.write(content)
            log_debug(f"🎤 Saved temp audio to: {tmp_path} ({len(content)} bytes)")

        transcript = ""
        
        # 1. Gemini STT (Multimodal)
        transcript = transcribe_with_gemini(tmp_path, mime_type=mime)
        
        # 2. Local Whisper Fallback
        if not transcript:
             try:
                log_debug("🎤 Gemini returned empty/fail, trying local Whisper fallback...")
                transcript = transcribe_audio_file(tmp_path)
             except Exception as e:
                log_debug(f"❌ Local Whisper failed: {e}")

        transcript = (transcript or "").strip()
        log_debug(f"🎤 Transcript result: '{transcript}'")
        
        if not transcript:
            return VoiceChatResponse(
                transcript="(Transcription failed)",
                chat=ChatResponse(
                    messages=[CoachMessage(text="I couldn't detect any speech in that audio. Please try again.")],
                    ui=UIState(mode="CHAT"),
                    effects=Effects()
                )
            )

        req = ChatRequest(
            user_id=user_id,
            message=transcript,
            coach=coach,
            topic=topic,
            profile=profile
        )
        
        log_debug("🎤 Calling chat_endpoint...")
        chat_resp = await chat_endpoint(req)
        log_debug("🎤 chat_endpoint success")
        
        return VoiceChatResponse(transcript=transcript, chat=chat_resp)

    except Exception as e:
        log_debug(f"❌ chat_voice CRITICAL ERROR: {e}")
        traceback.print_exc()
        return VoiceChatResponse(
            transcript="(Error)",
            chat=ChatResponse(
                messages=[CoachMessage(text=f"Voice processing error: {str(e)}")],
                ui=UIState(mode="CHAT"),
                effects=Effects()
            )
        )

    finally:
        try:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
