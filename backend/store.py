import json
from pathlib import Path
from datetime import datetime, timezone

DATA_DIR = Path(__file__).resolve().parent / "data"
STATE_FILE = DATA_DIR / "user_state.json"

def _load():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

def _save(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

def touch_user(user_id: str):
    data = _load()
    st = data.get(user_id, {})
    st["last_user_activity"] = datetime.now(timezone.utc).isoformat()
    data[user_id] = st
    _save(data)

def set_current_plan(user_id: str, plan: list[str]):
    data = _load()
    st = data.get(user_id, {})
    st["current_plan"] = plan
    st.setdefault("plan_progress", {})  # step_index -> "done"/"pending"
    data[user_id] = st
    _save(data)

def get_state(user_id: str):
    return _load().get(user_id, {})
