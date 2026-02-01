# backend/routers/chat.py
import os
import json
import re
import traceback
import tempfile
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field

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

VOICE_MIN_BYTES = int(os.getenv("VOICE_MIN_BYTES", "1500"))  # ~1.5KB

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


def _ffmpeg_exists() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return True
    except Exception:
        return False


def _transcode_to_wav(in_path: str) -> Optional[str]:
    """
    Best-effort conversion to WAV using ffmpeg, to avoid decode issues with WebM/Opus on servers.
    Returns wav path, or None if ffmpeg not available or conversion fails.
    """
    if not _ffmpeg_exists():
        return None

    out_fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(out_fd)

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        in_path,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-vn",
        out_path,
    ]

    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if proc.returncode != 0:
            try:
                os.remove(out_path)
            except Exception:
                pass
            return None

        try:
            if os.path.getsize(out_path) < 1000:
                os.remove(out_path)
                return None
        except Exception:
            return None

        return out_path
    except Exception:
        try:
            os.remove(out_path)
        except Exception:
            pass
        return None


def transcribe_audio_file(path: str) -> str:
    _init_whisper_if_needed()
    if not _whisper_ready or _whisper_model is None:
        raise HTTPException(
            status_code=500,
            detail="Whisper is not available on the server. Install faster-whisper or openai-whisper (and ffmpeg).",
        )

    wav_path = _transcode_to_wav(path)
    use_path = wav_path or path

    try:
        if _whisper_impl == "openai":
            result = _whisper_model.transcribe(use_path)  # type: ignore
            return (result.get("text") or "").strip()

        segments, _info = _whisper_model.transcribe(use_path)  # type: ignore
        parts: List[str] = []
        for seg in segments:
            t = getattr(seg, "text", "") or ""
            if t.strip():
                parts.append(t.strip())
        return " ".join(parts).strip()

    except Exception as e:
        print("❌ Whisper transcription failed:", repr(e))
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=(
                f"Whisper transcription error: {repr(e)}. "
                "Audio may be empty, truncated, or an unsupported format. "
                "If running on Render, installing ffmpeg usually fixes this."
            ),
        )
    finally:
        if wav_path:
            try:
                os.remove(wav_path)
            except Exception:
                pass


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
        raw = path.read_text(encoding="utf-8")
        if not raw.strip():
            return fallback
        return json.loads(raw)
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
    # NOTE: frontend treats non-"user" as assistant; keep "coach" for readability.
    role: str = "coach"
    text: str
    ts: str
    kind: Optional[str] = None


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


def _coach_msg(text: str, kind: Optional[str] = "coach") -> CoachMessage:
    return CoachMessage(role="coach", text=text, ts=_now_iso(), kind=kind)


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
    "followup": {
        "pending_at": None,
        "pending_for_ts": None,
        "last_sent_at": None,
    },
    "gates": {
        "awaiting_baseline_for": None,  # topic_key or None
        "pending_plan_topic": None,     # topic_key or None
    },
}


def _ensure_state_shape(state: Dict[str, Any]) -> Dict[str, Any]:
    merged = json.loads(json.dumps(DEFAULT_STATE))
    for k, v in (state or {}).items():
        merged[k] = v

    merged.setdefault("history", [])
    if not isinstance(merged["history"], list):
        merged["history"] = []

    merged.setdefault("metrics", {"confidence": {}})
    merged["metrics"].setdefault("confidence", {})

    merged.setdefault("plan_build", {})
    for k, v in DEFAULT_STATE["plan_build"].items():
        merged["plan_build"].setdefault(k, v)

    merged.setdefault("plans", {})
    if not isinstance(merged["plans"], dict):
        merged["plans"] = {}

    merged.setdefault("followup", {})
    for k, v in DEFAULT_STATE["followup"].items():
        merged["followup"].setdefault(k, v)

    merged.setdefault("gates", {})
    for k, v in DEFAULT_STATE["gates"].items():
        merged["gates"].setdefault(k, v)

    # Make sure every history row has required fields (prevents /history crashing)
    repaired: List[Dict[str, Any]] = []
    for m in merged.get("history", []):
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip() or "coach"
        text = str(m.get("text") or "").strip()
        ts = str(m.get("ts") or "").strip() or _now_iso()
        kind = m.get("kind")
        repaired.append({"role": role, "text": text, "ts": ts, "kind": kind})
    merged["history"] = repaired[-120:]

    return merged


# ===========================
# Intent / Topic router
# ===========================
_GREET_PATTERNS = [
    r"^(hi|hello|hey|hiya|yo)\b[!.\s]*$",
    r"^(good\s*(morning|afternoon|evening))\b[!.\s]*$",
]

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
    r"\bnext steps\b",
    r"\baction items\b",
    r"\bsteps\b",
    r"\bschedule\b",
    r"\bchecklist\b",
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


def is_greeting(user_text: str) -> bool:
    t = (user_text or "").strip().lower()
    return any(re.search(p, t) for p in _GREET_PATTERNS)


def explicit_new_plan_request(user_text: str) -> bool:
    return _matches_any(user_text, _NEW_PLAN_PATTERNS)


def skip_requested(user_text: str) -> bool:
    return _matches_any(user_text, _SKIP_PATTERNS)


def plan_requested(user_text: str) -> bool:
    if is_greeting(user_text):
        return False
    t = (user_text or "").strip().lower()
    if not t:
        return False
    if skip_requested(user_text):
        return False
    if _matches_any(user_text, _PLAN_REQUEST_PATTERNS):
        return True
    if "help me" in t:
        if any(k in t for k in ["plan", "roadmap", "next steps", "action items", "steps", "schedule", "checklist"]):
            return True
        return False
    return False


def refine_requested(user_text: str) -> bool:
    return _matches_any(user_text, _REFINE_PATTERNS)


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
    if is_greeting(user_text):
        return "general"

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
    if is_greeting(user_text):
        return "CHAT", None
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
# Follow-up
# ===========================
def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _schedule_followup(state: Dict[str, Any]) -> None:
    fu = state.setdefault("followup", {})
    now = _now()
    fu["pending_at"] = (now + timedelta(hours=FOLLOWUP_HOURS)).isoformat()

    last_user = next((m for m in reversed(state.get("history", [])) if m.get("role") == "user"), None)
    fu["pending_for_ts"] = last_user.get("ts") if isinstance(last_user, dict) else None


def _inject_due_followup_if_needed(state: Dict[str, Any], coach_id: Optional[str], topic_key: str) -> bool:
    fu = state.get("followup") or {}
    pending_at = _parse_iso(fu.get("pending_at"))
    pending_for_ts = fu.get("pending_for_ts")

    if not pending_at or not pending_for_ts:
        return False
    if _now() < pending_at:
        return False

    last_user = next((m for m in reversed(state.get("history", [])) if m.get("role") == "user"), None)
    if not last_user or last_user.get("ts") != pending_for_ts:
        fu["pending_at"] = None
        fu["pending_for_ts"] = None
        state["followup"] = fu
        return False

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
# Gemini helper (strong identity)
# ===========================
def _coach_identity(coach_id: Optional[str]) -> Tuple[str, str]:
    c = (coach_id or "").lower().strip()
    if c in ["kai", "male", "coach_kai"]:
        # IMPORTANT: identity lock
        name = "Kai"
        persona = (
            "You are Coach Kai (male). Friendly, direct, calm. Short sentences. Practical steps. "
            "Supportive but not overly bubbly."
        )
    else:
        name = "Mira"
        persona = (
            "You are Coach Mira (female). Warm, encouraging, conversational. Short and natural. "
            "Practical steps. Gentle confidence-building tone."
        )
    return name, persona


def gemini_text(system: str, user: str) -> str:
    """
    Note: Google genai SDK here doesn't support a strict system role the same way OpenAI does in all modes.
    We hard-prefix a "SYSTEM:" block and include identity lock text to reduce drift.
    """
    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Content(
                    role="user",
                    parts=[types.Part(text=f"SYSTEM:\n{system}\n\nUSER:\n{user}")]
                )
            ],
            config=types.GenerateContentConfig(temperature=0.7, max_output_tokens=700),
        )
        text = getattr(resp, "text", None)
        if text:
            return text.strip()
        if getattr(resp, "candidates", None):
            parts = resp.candidates[0].content.parts
            return "".join([p.text for p in parts if getattr(p, "text", None)]).strip()
        return ""
    except Exception as e:
        print("❌ GEMINI CALL FAILED")
        print("Model:", GEMINI_MODEL)
        print("Error:", repr(e))
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Gemini error: {repr(e)}")


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
# Confidence capture (1-10)
# ===========================
def maybe_capture_confidence(state: Dict[str, Any], user_text: str, topic_key: str) -> bool:
    t = (user_text or "").strip().lower()
    m = re.fullmatch(r"(\d{1,2})(?:\s*/\s*10)?", t)
    if not m:
        return False
    val = int(m.group(1))
    if val < 1 or val > 10:
        return False

    conf = state["metrics"]["confidence"].setdefault(topic_key, {})
    if "baseline" not in conf:
        conf["baseline"] = val
    conf["last"] = val
    conf["updated_at"] = _now_iso()
    return True


def _has_baseline(state: Dict[str, Any], topic_key: str) -> bool:
    conf = (state.get("metrics") or {}).get("confidence") or {}
    topic_conf = conf.get(topic_key) or {}
    return isinstance(topic_conf, dict) and isinstance(topic_conf.get("baseline"), int)


def _baseline_prompt(topic_key: str) -> str:
    pretty = topic_key.replace("_", " ")
    return (
        f"Before I build a plan for **{pretty}**, quick baseline.\n"
        "On a scale from **1–10**, what’s your confidence right now?"
    )


def _ensure_baseline_gate(state: Dict[str, Any], user_text: str, topic_key: str) -> Optional[ChatResponse]:
    """
    If user asks for a plan but no baseline exists, prompt baseline ONCE and block plan-building.
    Critical: do NOT spam the same prompt into history repeatedly.
    """
    if not plan_requested(user_text) and not explicit_new_plan_request(user_text):
        return None

    if _has_baseline(state, topic_key):
        state["gates"]["awaiting_baseline_for"] = None
        state["gates"]["pending_plan_topic"] = None
        return None

    gates = state.setdefault("gates", {})
    already_waiting = (gates.get("awaiting_baseline_for") == topic_key)

    gates["awaiting_baseline_for"] = topic_key
    gates["pending_plan_topic"] = topic_key
    state["gates"] = gates

    if already_waiting:
        # IMPORTANT: return no new coach message (frontend already shows the prompt)
        return ChatResponse(
            messages=[],
            ui=UIState(mode="CHAT", show_plan_sidebar=True),
            effects=Effects(saved_confidence=False),
            plan=None,
        )

    # First time: send the prompt once
    return ChatResponse(
        messages=[_coach_msg(_baseline_prompt(topic_key), kind="baseline_prompt")],
        ui=UIState(mode="CHAT", show_plan_sidebar=True),
        effects=Effects(saved_confidence=False),
        plan=None,
    )


# ===========================
# Learning resources
# ===========================
RESOURCE_CATALOG: Dict[str, List[Dict[str, str]]] = {
    "mlops": [
        {"title": "Google Cloud: MLOps (CD/CT pipelines) overview", "url": "https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning", "type": "doc"},
        {"title": "Vertex AI: MLOps & pipelines (overview)", "url": "https://cloud.google.com/vertex-ai/docs/pipelines/introduction", "type": "doc"},
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
# Plan primitives (NOW coach-aware)
# ===========================
def build_plan_object(topic_key: str, discovery_answers: Dict[str, Any], user_text: str, coach_id: Optional[str]) -> Dict[str, Any]:
    coach_name, coach_persona = _coach_identity(coach_id)

    deadline = discovery_answers.get("deadline") or "soon"
    target = discovery_answers.get("target") or "mixed"

    # Identity lock in planning too
    system = (
        f"{coach_persona}\n"
        f"Identity lock: You are Coach {coach_name}. Never claim to be any other coach.\n\n"
        "You are a practical, concise coach. Suggest a simple plan.\n"
        "Return ONLY a bullet list of actionable tasks (no headings, no paragraphs).\n"
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

    tasks = [{"text": t, "status": "todo", "resources": pick_resources(topic_key, t, max_items=3)} for t in task_texts]

    return {
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
def handle_chat(state: Dict[str, Any], user_text: str, topic_key: str, saved_conf: bool, coach_id: Optional[str]) -> ChatResponse:
    coach_name, coach_persona = _coach_identity(coach_id)

    pb = state["plan_build"]
    plan_id = pb.get("active_plan_id") if pb.get("topic") == topic_key else None
    has_plan = bool(plan_id) and plan_id in state["plans"]

    if show_plan_requested(user_text) and has_plan:
        plan = state["plans"][plan_id]
        state["mode"] = "CHAT"
        return ChatResponse(
            messages=[_coach_msg("Here’s your current plan. Want to work on step 1, or revise anything?")],
            ui=UIState(mode="CHAT", show_plan_sidebar=True, plan_link=f"/plans/{plan_id}", mermaid=plan_to_mermaid(plan)),
            effects=Effects(saved_confidence=saved_conf),
            plan=plan,
        )

    # Strong identity lock
    system = (
        f"{coach_persona}\n"
        f"Identity lock: You are Coach {coach_name}. "
        "Never claim you are Mira if you are Kai, and never claim you are Kai if you are Mira. "
        "Never introduce yourself as the other coach.\n\n"
        "You are a helpful coach. Keep responses short and natural.\n"
        "Do NOT create a plan unless the user explicitly asks for a plan.\n"
        "If the user is choosing a specific step from an existing plan, help them execute it with 3–6 concrete substeps.\n"
        "Avoid repeating the plan."
    )

    if has_plan:
        plan = state["plans"][plan_id]
        top_tasks = "\n".join([f"- {t['text']}" for t in (plan.get("tasks") or [])[:8]])
        user = (
            f"Topic: {topic_key}\n"
            f"Existing plan tasks:\n{top_tasks}\n\n"
            f"User message:\n{user_text}\n\n"
            "If the user picked a task, give a tiny checklist to start now (no new plan). "
            "Otherwise reply normally."
        )
    else:
        if saved_conf:
            user = (
                f"The user just provided a confidence number for topic '{topic_key}'. "
                f"User message: {user_text}\n"
                "Reply briefly. Do not ask more calibration questions."
            )
        else:
            user = user_text

    text = gemini_text(system, user)

    return ChatResponse(
        messages=[_coach_msg(text)],
        ui=UIState(mode="CHAT", show_plan_sidebar=has_plan, plan_link=(f"/plans/{plan_id}" if has_plan else None)),
        effects=Effects(saved_confidence=saved_conf),
        plan=None,
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
        # NOTE: draft will be called by caller with coach_id
        return ChatResponse(
            messages=[_coach_msg("Thanks — give me one moment and I’ll build your plan.")],
            ui=UIState(mode="PLAN_BUILD", show_plan_sidebar=True),
            effects=Effects(),
            plan=None,
        )

    question = DISCOVERY_QUESTIONS[q_asked]
    pb["discovery_questions_asked"] = q_asked + 1

    state["mode"] = "PLAN_BUILD"
    return ChatResponse(
        messages=[_coach_msg(question)],
        ui=UIState(mode="PLAN_BUILD", show_plan_sidebar=True),
        effects=Effects(),
        plan=None,
    )


def handle_plan_draft(state: Dict[str, Any], user_text: str, topic_key: str, coach_id: Optional[str]) -> ChatResponse:
    pb = state["plan_build"]
    pb["topic"] = topic_key
    pb["step"] = "DRAFT"

    if not should_create_new_plan(state, user_text, topic_key):
        pb["locked"] = True
        state["mode"] = "CHAT"
        active_id = pb.get("active_plan_id")
        plan = state["plans"].get(active_id) if active_id else None
        return ChatResponse(
            messages=[_coach_msg("You already have a plan for this topic. Want to work on step 1 or revise anything?")],
            ui=UIState(
                mode="CHAT",
                show_plan_sidebar=True,
                plan_link=(f"/plans/{active_id}" if active_id else None),
                mermaid=(plan_to_mermaid(plan) if plan else None),
            ),
            effects=Effects(),
            plan=None,
        )

    plan = build_plan_object(topic_key, pb.get("discovery_answers") or {}, user_text, coach_id=coach_id)
    state["plans"][plan["id"]] = plan
    pb["active_plan_id"] = plan["id"]
    pb["locked"] = True
    pb["step"] = "REFINE"

    mermaid_code = plan_to_mermaid(plan)
    plan_link = f"/plans/{plan['id']}"

    coach_text = (
        f"Awesome — I made a starter plan for **{plan['title']}**.\n"
        "I also attached learning resources under each step so you can implement right away.\n"
        "Want it more intense or more lightweight?"
    )

    state["mode"] = "CHAT"
    return ChatResponse(
        messages=[_coach_msg(coach_text)],
        ui=UIState(mode="CHAT", show_plan_sidebar=True, plan_link=plan_link, mermaid=mermaid_code),
        effects=Effects(created_plan_id=plan["id"]),
        plan=plan,
    )


def handle_plan_refine(state: Dict[str, Any], user_text: str, topic_key: str, coach_id: Optional[str]) -> ChatResponse:
    coach_name, coach_persona = _coach_identity(coach_id)

    pb = state["plan_build"]
    pb["topic"] = topic_key
    pb["step"] = "REFINE"

    plan_id = pb.get("active_plan_id")
    if not plan_id or plan_id not in state["plans"]:
        pb["step"] = "DRAFT"
        pb["locked"] = False
        return handle_plan_draft(state, user_text, topic_key, coach_id=coach_id)

    plan = state["plans"][plan_id]

    if explicit_new_plan_request(user_text):
        pb["locked"] = False
        pb["step"] = "DRAFT"
        pb["discovery_questions_asked"] = 0
        pb["discovery_answers"] = {}
        return handle_plan_draft(state, user_text, topic_key, coach_id=coach_id)

    if not refine_requested(user_text):
        state["mode"] = "CHAT"
        return ChatResponse(
            messages=[_coach_msg("Got it. Which step do you want to tackle today?")],
            ui=UIState(mode="CHAT", show_plan_sidebar=True, plan_link=f"/plans/{plan_id}", mermaid=plan_to_mermaid(plan)),
            effects=Effects(),
            plan=None,
        )

    system = (
        f"{coach_persona}\n"
        f"Identity lock: You are Coach {coach_name}. Never claim to be another coach.\n\n"
        "You are editing an existing plan. Do NOT create a new plan.\n"
        "Given the user's request, propose up to 5 concrete edits to tasks.\n"
        "Return ONLY a bullet list of edits using one of these verbs at the start:\n"
        "'ADD:', 'REMOVE:', 'CHANGE:', 'REORDER:'."
    )
    user = (
        f"Plan title: {plan.get('title')}\n"
        f"Existing tasks:\n"
        + "\n".join([f"- {t['text']}" for t in (plan.get('tasks') or [])][:12])
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
        messages=[_coach_msg(coach_text)],
        ui=UIState(mode="CHAT", show_plan_sidebar=True, plan_link=f"/plans/{plan_id}", mermaid=plan_to_mermaid(plan)),
        effects=Effects(updated_plan_id=plan_id),
        plan=plan,
    )


# ===========================
# Core processing
# ===========================
def process_chat_message(
    user_id: str,
    user_text: str,
    coach: Optional[str],
    profile: Optional[Dict[str, Any]],
    topic: Optional[str],
) -> ChatResponse:
    all_state = _load_all_state()
    bucket = _get_user_bucket(all_state, user_id)
    state = _ensure_state_shape(bucket)

    user_text = (user_text or "").strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="Empty message")

    if user_text.lower() == "ping":
        return ChatResponse(messages=[_coach_msg("")], ui=UIState(mode="CHAT"), effects=Effects(), plan=None)

    topic_key = normalize_topic_key(topic) or infer_topic_key(user_text, profile)

    _inject_due_followup_if_needed(state, coach_id=coach, topic_key=topic_key)

    # Duplicate user message guard
    if state.get("history"):
        last = state["history"][-1]
        if last.get("role") == "user" and (last.get("text") or "").strip() == user_text:
            return ChatResponse(
                messages=[_coach_msg("(duplicate received) Got it — can you add one more detail so I can help?")],
                ui=UIState(mode="CHAT", show_plan_sidebar=False),
                effects=Effects(),
                plan=None,
            )

    # Append user message
    state["history"].append({"role": "user", "text": user_text, "ts": _now_iso(), "kind": "user"})
    state["history"] = state["history"][-120:]

    _schedule_followup(state)

    # Capture confidence if user sent a number
    saved_conf = maybe_capture_confidence(state, user_text, topic_key)

    gates = state.get("gates") or {}
    awaiting_for = gates.get("awaiting_baseline_for")
    pending_plan_topic = gates.get("pending_plan_topic")

    if saved_conf and awaiting_for == topic_key:
        gates["awaiting_baseline_for"] = None
        state["gates"] = gates

    # Baseline gate (prompt ONCE)
    gate_resp = _ensure_baseline_gate(state, user_text, topic_key)
    if gate_resp is not None:
        # Persist only if we actually returned a new coach message
        if gate_resp.messages:
            m0 = gate_resp.messages[0]
            state["history"].append({"role": "coach", "text": m0.text, "ts": m0.ts, "kind": (m0.kind or "coach")})
            state["history"] = state["history"][-120:]

        bucket.clear()
        bucket.update(state)
        _save_all_state(all_state)
        return gate_resp

    # If baseline just arrived and a plan was pending, start discovery cleanly
    if saved_conf and pending_plan_topic == topic_key:
        gates["pending_plan_topic"] = None
        state["gates"] = gates

        pb = state["plan_build"]
        pb["topic"] = topic_key
        pb["step"] = "DISCOVERY"
        pb["discovery_questions_asked"] = 0
        pb["discovery_answers"] = pb.get("discovery_answers") or {}
        pb["locked"] = False
        state["mode"] = "PLAN_BUILD"

        resp = handle_plan_discovery(state, user_text, topic_key)

        # If discovery immediately completed (rare), draft
        if state["plan_build"].get("step") == "DRAFT" and state["plan_build"].get("discovery_questions_asked", 0) >= len(DISCOVERY_QUESTIONS):
            resp = handle_plan_draft(state, user_text, topic_key, coach_id=coach)

    else:
        mode, step = decide_mode_and_step(state, user_text, topic_key)
        state["mode"] = mode

        if mode == "CHAT":
            resp = handle_chat(state, user_text, topic_key, saved_conf, coach_id=coach)

        elif mode == "PLAN_BUILD":
            if step == "DISCOVERY":
                resp = handle_plan_discovery(state, user_text, topic_key)

                # if we just finished discovery, draft plan
                pb = state["plan_build"]
                if pb.get("step") == "DRAFT" or (pb.get("discovery_questions_asked", 0) >= len(DISCOVERY_QUESTIONS)):
                    resp = handle_plan_draft(state, user_text, topic_key, coach_id=coach)

            elif step == "DRAFT":
                resp = handle_plan_draft(state, user_text, topic_key, coach_id=coach)
            else:
                resp = handle_plan_refine(state, user_text, topic_key, coach_id=coach)

        else:
            state["mode"] = "CHAT"
            resp = handle_chat(state, user_text, topic_key, saved_conf, coach_id=coach)

    # Persist coach reply using SAME ts/kind as returned
    if resp.messages:
        m0 = resp.messages[0]
        state["history"].append({"role": "coach", "text": m0.text, "ts": m0.ts, "kind": (m0.kind or "coach")})
        state["history"] = state["history"][-120:]

    bucket.clear()
    bucket.update(state)
    _save_all_state(all_state)

    return resp


# ===========================
# Main endpoint (text)
# ===========================
@router.post("", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    return process_chat_message(
        user_id=req.user_id,
        user_text=req.message,
        coach=req.coach,
        profile=req.profile,
        topic=req.topic,
    )


# ===========================
# History endpoint (NEVER crash)
# ===========================
@router.get("/history", response_model=HistoryResponse)
def chat_history(
    user_id: str,
    topic: Optional[str] = None,
    coach: Optional[str] = None,
) -> HistoryResponse:
    try:
        all_state = _load_all_state()
        bucket = _get_user_bucket(all_state, user_id)
        state = _ensure_state_shape(bucket)

        topic_key = normalize_topic_key(topic) or "general"

        _inject_due_followup_if_needed(state, coach_id=coach, topic_key=topic_key)

        # Persist repaired state so we don't keep crashing on old rows
        bucket.clear()
        bucket.update(state)
        _save_all_state(all_state)

        msgs: List[HistoryMessage] = []
        for m in state.get("history", []):
            if not isinstance(m, dict):
                continue
            role = str(m.get("role") or "coach")
            text = str(m.get("text") or "")
            ts = str(m.get("ts") or "") or _now_iso()
            kind = m.get("kind")
            # Always append safely (no Pydantic crash)
            msgs.append(HistoryMessage(role=role, text=text, ts=ts, kind=kind))

        return HistoryResponse(topic=topic_key, messages=msgs)
    except Exception as e:
        # IMPORTANT: never 500/502 this endpoint
        print("❌ /chat/history failed:", repr(e))
        traceback.print_exc()
        return HistoryResponse(topic=normalize_topic_key(topic) or "general", messages=[])


# ===========================
# Voice endpoint (audio -> whisper -> chat)
# ===========================
@router.post("/voice", response_model=VoiceChatResponse)
async def chat_voice(
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    coach: Optional[str] = Form(None),
    topic: Optional[str] = Form(None),
    profile_json: Optional[str] = Form(None),
) -> VoiceChatResponse:
    profile: Optional[Dict[str, Any]] = None
    if profile_json:
        try:
            profile = json.loads(profile_json)
        except Exception:
            profile = None

    suffix = ".webm"
    try:
        name = (audio.filename or "").lower()
        if "." in name:
            suffix = "." + name.split(".")[-1]
    except Exception:
        suffix = ".webm"

    tmp_path = None
    try:
        content = await audio.read()

        if not content or len(content) < VOICE_MIN_BYTES:
            raise HTTPException(
                status_code=400,
                detail="Voice message was too short/empty. Hold the mic for 2–3 seconds and try again.",
            )

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            tmp.write(content)
            tmp.flush()
            try:
                os.fsync(tmp.fileno())
            except Exception:
                pass

        try:
            sz = os.path.getsize(tmp_path)
        except Exception:
            sz = 0

        print(
            f"🎙️ voice upload: filename={audio.filename} content_type={audio.content_type} "
            f"bytes={len(content)} file_size={sz} tmp={tmp_path}"
        )

        if sz < VOICE_MIN_BYTES:
            raise HTTPException(
                status_code=400,
                detail="Voice message file was incomplete. Please try again (longer recording).",
            )

        transcript = transcribe_audio_file(tmp_path)
        transcript = (transcript or "").strip()
        if not transcript:
            transcript = "(Couldn’t detect speech)"

        chat_resp = process_chat_message(
            user_id=user_id,
            user_text=transcript,
            coach=coach,
            profile=profile,
            topic=topic,
        )
        return VoiceChatResponse(transcript=transcript, chat=chat_resp)

    finally:
        try:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
