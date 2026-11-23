import Stripe from 'stripe';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { shopifyApi } from '@shopify/shopify-api';
import axios from 'axios';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
const twilioClient = twilio(process.env.TWILIO_SID!, process.env.TWILIO_TOKEN!);
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_KEY!,
  apiSecretKey: process.env.SHOPIFY_SECRET!,
  hostName: 'example.myshopify.com',
});

export async function chargeCard(token: string) {
  // Legacy Charges API flow - source token based
  return stripe.charges.create({
    amount: 2000,
    currency: 'usd',
    source: token,
    description: 'Monthly subscription',
  });
}

export async function fixGrammar(input: string) {
  // Edits API was sunset by OpenAI
  return openai.edits.create({
    model: 'text-davinci-edit-001',
    input,
    instruction: 'Fix the grammar.',
  });
}

export async function legacyComplete(prompt: string) {
  return openai.completions.create({
    model: 'text-davinci-003',
    prompt,
    max_tokens: 200,
  });
}

export async function sendSms(to: string, body: string) {
  return twilioClient.messages.create({
    body,
    to,
    from: '+15550100',
    statusCallback: 'https://example.com/twilio/status',
  });
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signIn({ email, password });
}

export async function listShopifyProducts(session: unknown) {
  // @ts-expect-error session shape comes from shopify session storage
  return shopify.rest.Product.all({ session });
}

export async function rawEditCall(instruction: string) {
  return axios.post('https://api.openai.com/v1/edits', {
    model: 'text-davinci-edit-001',
    instruction,
  });
}
