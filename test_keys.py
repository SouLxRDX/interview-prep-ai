import os
from dotenv import load_dotenv
from groq import Groq

load_dotenv()

# ── Test Groq Keys ──
print("=" * 40)
print("GROQ KEYS")
print("=" * 40)

groq_keys = [k.strip() for k in os.getenv("GROQ_API_KEYS", "").split(",") if k.strip()]
print(f"Found {len(groq_keys)} key(s)\n")

for i, key in enumerate(groq_keys):
    print(f"Testing key {i+1}: {key[:8]}...{key[-4:]}")
    try:
        client = Groq(api_key=key)
        res = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": "Say OK"}],
            max_tokens=5,
        )
        print(f"  ✅ WORKING — response: {res.choices[0].message.content}\n")
    except Exception as e:
        print(f"  ❌ FAILED — {str(e)[:80]}\n")

# ── Test Gemini Keys ──
print("=" * 40)
print("GEMINI KEYS")
print("=" * 40)

gemini_keys = [k.strip() for k in os.getenv("GEMINI_API_KEYS", "").split(",") if k.strip()]
print(f"Found {len(gemini_keys)} key(s)\n")

if not gemini_keys:
    print("  ⚠️  No Gemini keys found in .env\n")
else:
    try:
        from google import genai
        for i, key in enumerate(gemini_keys):
            print(f"Testing key {i+1}: {key[:8]}...{key[-4:]}")
            try:
                client = genai.Client(api_key=key)
                res = client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents=[{"role": "user", "parts": [{"text": "Say OK"}]}],
                )
                print(f"  ✅ WORKING — response: {res.text.strip()}\n")
            except Exception as e:
                print(f"  ❌ FAILED — {str(e)[:80]}\n")
    except ImportError:
        print("  ❌ google-genai not installed. Run: pip install google-genai\n")
print("=" * 40)
print("DONE")
print("=" * 40)