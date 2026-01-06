from fastapi import APIRouter
from typing import Optional
from pydantic import BaseModel

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatIn(BaseModel):
    user_id: Optional[int] = None
    message: str

class ChatOut(BaseModel):
    reply: str

@router.post("/", response_model=ChatOut)
def chat_message(payload: ChatIn):
    # MVP: echo back; later wire to LLM + plan logic
    return ChatOut(reply=f"You said: {payload.message}")
