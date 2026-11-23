import os
import requests
import stripe
from openai import OpenAI
from supabase import create_client
from twilio.rest import Client as TwilioClient
import shopify

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
twilio_client = TwilioClient(os.environ["TWILIO_SID"], os.environ["TWILIO_TOKEN"])


def charge_card(token):
    # Legacy Stripe Charges API (deprecated in favor of PaymentIntents)
    return stripe.Charge.create(
        amount=2000,
        currency="usd",
        source=token,
        description="Monthly subscription",
    )


def edit_text(text):
    # Edits endpoint sunset by OpenAI
    return openai_client.edits.create(
        model="text-davinci-edit-001",
        input=text,
        instruction="Fix the grammar.",
    )


def legacy_complete(prompt):
    return openai_client.completions.create(
        model="text-davinci-003",
        prompt=prompt,
        max_tokens=200,
    )


def send_sms(to, body):
    return twilio_client.messages.create(
        body=body,
        to=to,
        from_="+15550100",
        status_callback="https://example.com/twilio/status",
    )


def login(email, password):
    return supabase.auth.sign_in(email=email, password=password)


def list_products():
    shopify.Session.setup(api_key=os.environ["SHOPIFY_KEY"], secret=os.environ["SHOPIFY_SECRET"])
    return shopify.Product.find(limit=50)


def raw_edit(instruction):
    return requests.post(
        "https://api.openai.com/v1/edits",
        json={"model": "text-davinci-edit-001", "instruction": instruction},
        timeout=10,
    )
