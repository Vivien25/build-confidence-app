from fastapi import APIRouter

router = APIRouter(prefix="/progress", tags=["progress"])

@router.get("/me")
def my_progress():
    # MVP stub
    return {"ratings": [40, 48, 52]}
