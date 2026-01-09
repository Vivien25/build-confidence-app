import json
import os
from pathlib import Path
from typing import Dict, Any

DATA_DIR = Path(__file__).resolve().parent / "data"
MEM_FILE = DATA_DIR / "memory.json"

def _load_all() -> Dict[str, Any]:
    try:
        return json.loads(MEM_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

def _save_all(all_mem: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEM_FILE.write_text(json.dumps(all_mem, indent=2, ensure_ascii=False), encoding="utf-8")

def get_memory(user_id: str) -> Dict[str, Any]:
    all_mem = _load_all()
    return all_mem.get(user_id, {})

def set_memory(user_id: str, memory: Dict[str, Any]) -> None:
    all_mem = _load_all()
    all_mem[user_id] = memory
    _save_all(all_mem)
