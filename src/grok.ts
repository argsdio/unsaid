import OpenAI from "openai";

// xAI is OpenAI-wire-compatible, so the official SDK works against their base URL.
const BASE_URL = "https://api.x.ai/v1";

export const GROK_MODEL = process.env.GROK_MODEL ?? "grok-4";

let client: OpenAI | undefined;

// Returns null when no key is set, which is how the harness and the resolver
// tests run with no network.
export function grok(): OpenAI | null {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  client ??= new OpenAI({ apiKey, baseURL: BASE_URL });
  return client;
}
