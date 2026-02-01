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

# Minimum size gate to avoid EOFError from truncated uploads
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


# ✅ Fix A: add stable ts (and optional kind) to /chat messages
class CoachMessage(BaseModel):
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
    # ✅ Create coach message once with stable ts for Fix A
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
    # ✅ 12-hour follow-up tracking (Option B)
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

    for m in merged.get("history", []):
        if isinstance(m, dict):
            m.setdefault("kind", None)

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


def is_greeting(user_text: str) -> bool:
    t = (user_text or "").strip().lower()
    return any(re.search(p, t) for p in _GREET_PATTERNS)


def explicit_new_plan_request(user_text: str) -> bool:
    return _matches_any(user_text, _NEW_PLAN_PATTERNS)


def plan_requested(user_text: str) -> bool:
    if is_greeting(user_text):
        return False
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
# Follow-up (Option B)
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
# Gemini helpers
# ===========================
def gemini_text(system: str, user: str) -> str:
    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
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
# Confidence capture
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
# Plan primitives
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
def _coach_style(coach_id: Optional[str]) -> str:
    c = (coach_id or "").lower().strip()
    if c in ["kai", "male", "coach_kai"]:
        return (
            "You are Coach Kai (male). Friendly, direct, calm. "
            "Short sentences. Practical steps. Supportive but not overly bubbly."
        )
    return (
        "You are Coach Mira (female). Warm, encouraging, conversational. "
        "Short and natural. Practical steps. Gentle confidence-building tone."
    )


def handle_chat(state: Dict[str, Any], user_text: str, topic_key: str, saved_conf: bool, coach_id: Optional[str]) -> ChatResponse:
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

    system = (
        f"{_coach_style(coach_id)}\n\n"
        "You are a helpful coach. Keep responses short and natural. "
        "Do NOT create a plan unless user asks for one. "
        "If user is choosing a specific step from an existing plan, help them execute it with 3–6 concrete substeps. "
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
        return handle_plan_draft(state, user_text, topic_key)

    question = DISCOVERY_QUESTIONS[q_asked]
    pb["discovery_questions_asked"] = q_asked + 1

    state["mode"] = "PLAN_BUILD"
    return ChatResponse(
        messages=[_coach_msg(question)],
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

    plan = build_plan_object(topic_key, pb.get("discovery_answers") or {}, user_text)
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
            messages=[_coach_msg("Got it. Which step do you want to tackle today?")],
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

    if state.get("history"):
        last = state["history"][-1]
        if last.get("role") == "user" and (last.get("text") or "").strip() == user_text:
            return ChatResponse(
                messages=[_coach_msg("(duplicate received) Got it — can you add one more detail so I can help?")],
                ui=UIState(mode="CHAT", show_plan_sidebar=False),
                effects=Effects(),
                plan=None,
            )

    state["history"].append({"role": "user", "text": user_text, "ts": _now_iso(), "kind": "user"})
    state["history"] = state["history"][-120:]

    _schedule_followup(state)

    saved_conf = maybe_capture_confidence(state, user_text, topic_key)

    mode, step = decide_mode_and_step(state, user_text, topic_key)
    state["mode"] = mode

    if mode == "CHAT":
        resp = handle_chat(state, user_text, topic_key, saved_conf, coach_id=coach)
    elif mode == "PLAN_BUILD":
        if step == "DISCOVERY":
            resp = handle_plan_discovery(state, user_text, topic_key)
        elif step == "DRAFT":
            resp = handle_plan_draft(state, user_text, topic_key)
        else:
            resp = handle_plan_refine(state, user_text, topic_key)
    else:
        state["mode"] = "CHAT"
        resp = handle_chat(state, user_text, topic_key, saved_conf, coach_id=coach)

    # ✅ Fix A: persist coach reply using the SAME ts/kind as returned in /chat
    if resp.messages:
        m0 = resp.messages[0]
        state["history"].append(
            {"role": "coach", "text": m0.text, "ts": m0.ts, "kind": (m0.kind or "coach")}
        )
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
# History endpoint
# ===========================
@router.get("/history", response_model=HistoryResponse)
def chat_history(
    user_id: str,
    topic: Optional[str] = None,
    coach: Optional[str] = None,
) -> HistoryResponse:
    all_state = _load_all_state()
    bucket = _get_user_bucket(all_state, user_id)
    state = _ensure_state_shape(bucket)

    topic_key = normalize_topic_key(topic) or "general"

    _inject_due_followup_if_needed(state, coach_id=coach, topic_key=topic_key)

    bucket.clear()
    bucket.update(state)
    _save_all_state(all_state)

    msgs = [HistoryMessage(**m) for m in state.get("history", [])]
    return HistoryResponse(topic=topic_key, messages=msgs)


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
