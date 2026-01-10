from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from db import SessionLocal, engine, Base
from models import User

Base.metadata.create_all(bind=engine)

router = APIRouter(prefix="/users", tags=["users"])

class LoginIn(BaseModel):
    name: str
    email: EmailStr

class LoginOut(BaseModel):
    user_id: str
    name: str
    email: str

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.post("/login", response_model=LoginOut)
def login(payload: LoginIn):
    name = payload.name.strip()
    email = payload.email.strip().lower()

    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    db: Session = SessionLocal()

    try:
        user = db.query(User).filter(User.email == email).first()
        if user:
            # update name in case it changed
            user.name = name
            db.add(user)
            db.commit()
            db.refresh(user)
        else:
            user = User(email=email, name=name)
            db.add(user)
            db.commit()
            db.refresh(user)

        return {"user_id": user.user_id, "name": user.name, "email": user.email}
    finally:
        db.close()
