
from dotenv import load_dotenv
import os

# Load WITH override
load_dotenv("backend/.env", override=True)
file_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")

print(f"File Key (.env):       {file_key[:4]}...{file_key[-4:] if file_key else 'None'}")
