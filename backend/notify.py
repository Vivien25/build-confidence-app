# backend/notify.py
import os
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, EmailStr

# ---- SendGrid (recommended) ----
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

router = APIRouter(prefix="/notify", tags=["notify"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
USERS_FILE = DATA_DIR / "users_activity.json"

SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY")
FROM_EMAIL = os.getenv("FROM_EMAIL")  # verified sender
SCHEDULER_TOKEN = os.getenv("SCHEDULER_TOKEN")  # a random secret string

CHECKIN_AFTER_HOURS = float(os.getenv("CHECKIN_AFTER_HOURS", "12"))
EMAIL_COOLDOWN_HOURS = float(os.getenv("EMAIL_COOLDOWN_HOURS", "12"))

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

def _load_users() -> Dict[str, Any]:
    if not USERS_FILE.exists():
        return {"users": {}}
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"users": {}}

def _save_users(data: Dict[str, Any]) -> None:
    USERS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()

def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

class ActivityPing(BaseModel):
    user_id: str
    email: EmailStr | None = None
    focus: str | None = None
    need_slug: str | None = None
    need_label: str | None = None

class SchedulerRunResp(BaseModel):
    emailed: int
    considered: int

def _send_email(to_email: str, subject: str, content: str) -> None:
    if not SENDGRID_API_KEY or not FROM_EMAIL:
        raise RuntimeError("Email service not configured (SENDGRID_API_KEY / FROM_EMAIL).")

    msg = Mail(
        from_email=FROM_EMAIL,
        to_emails=to_email,
        subject=subject,
        plain_text_content=content,
    )
    SendGridAPIClient(SENDGRID_API_KEY).send(msg)

@router.post("/activity")
def record_activity(payload: ActivityPing):
    """
    Frontend calls this when:
    - Chat page opens
    - User sends a message
    """
    db = _load_users()
    users = db.setdefault("users", {})

    u = users.setdefault(payload.user_id, {})
    u["user_id"] = payload.user_id
    if payload.email:
        u["email"] = payload.email

    u["last_active_utc"] = _iso(_utcnow())

    # optional: store last context (not required)
    if payload.focus:
        u["focus"] = payload.focus
    if payload.need_slug:
        u["need_slug"] = payload.need_slug
    if payload.need_label:
        u["need_label"] = payload.need_label

    _save_users(db)
    return {"ok": True}

@router.post("/run-checkins", response_model=SchedulerRunResp)
def run_checkins(x_scheduler_token: str | None = Header(default=None)):
    """
    Cloud Scheduler calls this endpoint.
    Protect it with a secret header token.
    """
    if not SCHEDULER_TOKEN:
        raise HTTPException(status_code=500, detail="SCHEDULER_TOKEN not configured")
    if x_scheduler_token != SCHEDULER_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")

    now = _utcnow()
    cutoff = now - timedelta(hours=CHECKIN_AFTER_HOURS)
    cooldown_cutoff = now - timedelta(hours=EMAIL_COOLDOWN_HOURS)

    db = _load_users()
    users = db.get("users", {})

    emailed = 0
    considered = 0

    for user_id, u in users.items():
        considered += 1

        email = u.get("email")
        last_active_s = u.get("last_active_utc")
        if not email or not last_active_s:
            continue

        try:
            last_active = _parse_iso(last_active_s)
        except Exception:
            continue

        # Only email if inactive >= 12 hours
        if last_active > cutoff:
            continue

        # Cooldown so we don't spam
        last_emailed_s = u.get("last_checkin_email_utc")
        if last_emailed_s:
            try:
                last_emailed = _parse_iso(last_emailed_s)
                if last_emailed > cooldown_cutoff:
                    continue
            except Exception:
                pass

        focus = u.get("focus", "work")
        need_label = u.get("need_label") or u.get("need_slug") or "your plan"

        subject = "Quick check-in: your plan progress"
        content = (
            f"Hi!\n\n"
            f"It’s been about {CHECKIN_AFTER_HOURS:g} hours since you last opened Better Me.\n"
            f"Did you get a chance to work on your {focus} / {need_label} plan?\n\n"
            f"Open Better Me to reply and continue.\n"
        )

        try:
            _send_email(email, subject, content)
            u["last_checkin_email_utc"] = _iso(now)
            emailed += 1
        except Exception:
            # If email fails, don't update timestamp so it can retry next run
            continue

    _save_users(db)
    return SchedulerRunResp(emailed=emailed, considered=considered)
