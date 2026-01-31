
from dotenv import load_dotenv
import os

print("--- Checking ROOT .env ---")
load_dotenv(".env", override=True)
root_key = os.getenv("GEMINI_API_KEY")
print(f"Root Key:      {root_key[:4]}...{root_key[-4:] if root_key else 'None'}")

print("\n--- Checking BACKEND .env ---")
load_dotenv("backend/.env", override=True)
backend_key = os.getenv("GEMINI_API_KEY")
print(f"Backend Key:   {backend_key[:4]}...{backend_key[-4:] if backend_key else 'None'}")
