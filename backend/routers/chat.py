import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from google import genai
from google.genai import types

router = APIRouter()

class ChatRequest(BaseModel):
    message: str

class ChatResponse(BaseModel):
    reply: str

SYSTEM_PROMPT = """
You are a supportive confidence coach.
1) Briefly reflect what the user is feeling
2) Give 1–2 actionable confidence-building tips
3) End with a gentle follow-up question
Keep it concise and human.
""".strip()

def make_client():
    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Set GOOGLE_API_KEY (or GEMINI_API_KEY)")
    return genai.Client(api_key=api_key)

@router.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    try:
        client = make_client()

        # Gemini 3 (preview). If your key/account doesn’t have access, switch to gemini-2.5-flash.
        model_id = "gemini-3-flash-preview"

        resp = client.models.generate_content(
            model=model_id,
            contents=req.message,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                temperature=0.7,
                max_output_tokens=600,
            ),
        )

        text = (resp.text or "").strip()
        if not text:
            text = "I’m here with you. What’s one thing you’d like to feel more confident about today?"
        return ChatResponse(reply=text)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini error: {e}")
