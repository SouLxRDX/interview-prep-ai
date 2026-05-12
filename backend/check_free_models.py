import requests

url = "https://openrouter.ai/api/v1/models"

response = requests.get(url)

models = response.json()["data"]

print("\n===== REAL FREE MODELS =====\n")

for model in models:

    model_id = model.get("id", "")

    pricing = model.get("pricing", {})

    prompt_price = pricing.get("prompt", "1")
    completion_price = pricing.get("completion", "1")

    # STRICT FREE CHECK
    if (
        ":free" in model_id
        and prompt_price == "0"
        and completion_price == "0"
    ):

        print(model_id)

print("\n===== DONE =====")