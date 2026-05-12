import os
from dotenv import load_dotenv
from groq import Groq

# Load backend/.env
load_dotenv(".env")

# ─────────────────────────────────────────────
# TEST GROQ KEYS
# ─────────────────────────────────────────────

print("=" * 50)
print("TESTING GROQ KEYS")
print("=" * 50)

groq_keys = [
    k.strip()
    for k in os.getenv("GROQ_API_KEYS", "").split(",")
    if k.strip()
]

print(f"Found {len(groq_keys)} Groq key(s)\n")

if not groq_keys:
    print("❌ No Groq keys found\n")

for i, key in enumerate(groq_keys, start=1):

    print(f"Testing Groq key {i}: {key[:8]}...{key[-4:]}")

    try:
        client = Groq(api_key=key)

        res = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {
                    "role": "user",
                    "content": "Say OK"
                }
            ],
            max_tokens=5,
        )

        print(f"✅ WORKING — response: {res.choices[0].message.content}\n")

    except Exception as e:
        print(f"❌ FAILED — {str(e)[:120]}\n")


# ─────────────────────────────────────────────
# TEST GEMINI KEYS
# ─────────────────────────────────────────────

print("=" * 50)
print("TESTING GEMINI KEYS")
print("=" * 50)

gemini_keys = [
    k.strip()
    for k in os.getenv("GEMINI_API_KEYS", "").split(",")
    if k.strip()
]

print(f"Found {len(gemini_keys)} Gemini key(s)\n")

if not gemini_keys:

    print("❌ No Gemini keys found")
    print("Check your .env file:")
    print("GEMINI_API_KEYS=key1,key2,key3\n")

else:

    try:
        from google import genai

        for i, key in enumerate(gemini_keys, start=1):

            print(f"Testing Gemini key {i}: {key[:8]}...{key[-4:]}")

            try:

                client = genai.Client(api_key=key)

                res = client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents="Say OK"
                )

                print(f"✅ WORKING — response: {res.text.strip()}\n")

            except Exception as e:

                print(f"❌ FAILED — {str(e)[:120]}\n")

    except ImportError:

        print("❌ google-genai package not installed")
        print("Run:")
        print("pip install google-genai\n")


print("=" * 50)
print("DONE")
print("=" * 50)