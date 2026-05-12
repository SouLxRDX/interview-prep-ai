import os
import requests
from dotenv import load_dotenv

load_dotenv()

print("\n" + "="*50)
print("TESTING GROQ KEYS")
print("="*50)

groq_keys = os.getenv("GROQ_API_KEYS", "").split(",")
groq_keys = [k.strip() for k in groq_keys if k.strip()]

print(f"Found {len(groq_keys)} Groq key(s)\n")

if not groq_keys:
    print("❌ No Groq keys found")
    print("Check your .env file:")
    print("GROQ_API_KEYS=key1,key2,key3")
else:
    for i, key in enumerate(groq_keys, 1):
        print(f"Testing Groq key {i}: {key[:8]}...{key[-4:]}")

        try:
            response = requests.get(
                "https://api.groq.com/openai/v1/models",
                headers={
                    "Authorization": f"Bearer {key}"
                },
                timeout=15
            )

            if response.status_code == 200:
                print("✅ WORKING — response: OK\n")
            else:
                print(f"❌ FAILED — status: {response.status_code}")
                print(response.text[:200] + "\n")

        except Exception as e:
            print(f"❌ ERROR — {e}\n")


print("="*50)
print("TESTING OPENROUTER KEYS")
print("="*50)

openrouter_keys = os.getenv("OPENROUTER_API_KEYS", "").split(",")
openrouter_keys = [k.strip() for k in openrouter_keys if k.strip()]

print(f"Found {len(openrouter_keys)} OpenRouter key(s)\n")

if not openrouter_keys:
    print("❌ No OpenRouter keys found")
    print("Check your .env file:")
    print("OPENROUTER_API_KEYS=key1,key2,key3")
else:
    for i, key in enumerate(openrouter_keys, 1):
        print(f"Testing OpenRouter key {i}: {key[:8]}...{key[-4:]}")

        try:
            response = requests.get(
                "https://openrouter.ai/api/v1/models",
                headers={
                    "Authorization": f"Bearer {key}"
                },
                timeout=15
            )

            if response.status_code == 200:
                print("✅ WORKING — response: OK\n")
            else:
                print(f"❌ FAILED — status: {response.status_code}")
                print(response.text[:200] + "\n")

        except Exception as e:
            print(f"❌ ERROR — {e}\n")


print("="*50)
print("TESTING GEMINI KEYS")
print("="*50)

gemini_keys = os.getenv("GEMINI_API_KEYS", "").split(",")
gemini_keys = [k.strip() for k in gemini_keys if k.strip()]

print(f"Found {len(gemini_keys)} Gemini key(s)\n")

if not gemini_keys:
    print("❌ No Gemini keys found")
    print("Check your .env file:")
    print("GEMINI_API_KEYS=key1,key2,key3")
else:
    for i, key in enumerate(gemini_keys, 1):
        print(f"Testing Gemini key {i}: {key[:8]}...{key[-4:]}")

        try:
            response = requests.get(
                f"https://generativelanguage.googleapis.com/v1/models?key={key}",
                timeout=15
            )

            if response.status_code == 200:
                print("✅ WORKING — response: OK\n")
            else:
                print(f"❌ FAILED — status: {response.status_code}")
                print(response.text[:200] + "\n")

        except Exception as e:
            print(f"❌ ERROR — {e}\n")


print("="*50)
print("DONE")
print("="*50)