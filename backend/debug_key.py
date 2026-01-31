
import os
from dotenv import load_dotenv

load_dotenv("backend/.env", override=True)
key = os.getenv("GEMINI_API_KEY")

print(f"Key loaded: {'YES' if key else 'NO'}")
if key:
    print(f"Length: {len(key)}")
    print(f"Prefix: {key[:4]}")
    print(f"Suffix: {key[-4:]}")
    print(f"Contains quotes? {'\"' in key or '\'' in key}")
    print(f"Contains whitespace? {' ' in key}")
    
    # Try a simple curl to validate if it works at all (using list models endpoint)
    import requests
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
    try:
        resp = requests.get(url)
        print(f"API Test Status: {resp.status_code}")
        if resp.status_code != 200:
            print(f"API Error: {resp.text}")
    except Exception as e:
        print(f"Request failed: {e}")
