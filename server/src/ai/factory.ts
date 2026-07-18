import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { fetchPublicUrl } from "../security.ts";
import type { BusinessProfile } from "../types.ts";

/**
 * Factory-side AI helpers (one-shot, quality-over-latency — these run when an
 * operator builds a receptionist, never during live calls). Uses Claude Opus.
 */

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

export function factoryAiAvailable(): boolean {
  return !!config.anthropicKey && !config.mockProviders;
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Business name" },
    industry: { type: "string", description: "Business type, e.g. 'dental clinic', 'hair salon'" },
    description: { type: "string", description: "1-2 sentence plain description of the business" },
    address: { type: "string", description: "Street address if found, else empty string" },
    email: { type: "string", description: "Contact email if found, else empty string" },
    services: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "string", description: "Price as displayed, e.g. '$45' or '' if unknown" },
          description: { type: "string" },
        },
        required: ["name", "price", "description"],
        additionalProperties: false,
      },
    },
    faqs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
        required: ["question", "answer"],
        additionalProperties: false,
      },
    },
    policies: { type: "string", description: "Any policies found: cancellation, parking, insurance, payment methods. Empty string if none." },
  },
  required: ["name", "industry", "description", "address", "email", "services", "faqs", "policies"],
  additionalProperties: false,
} as const;

/** Fetch a business website and extract structured onboarding data. */
export async function extractFromWebsite(url: string): Promise<Record<string, unknown>> {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  // fetchPublicUrl refuses private/internal hosts on every redirect hop (SSRF guard).
  const res = await fetchPublicUrl(normalized, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; CallCatcher/1.0)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Could not fetch ${normalized} (HTTP ${res.status})`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60000);

  const response = await getClient().messages.create({
    model: config.factoryModel,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", schema: EXTRACT_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [
      {
        role: "user",
        content: `Extract structured business information from this website text so we can set up an AI phone receptionist for them. Only include facts actually present in the text — leave fields empty rather than guessing.\n\nWebsite: ${normalized}\n\n---\n${text}`,
      },
    ],
  } as any);

  const textBlock = response.content.find((b: any) => b.type === "text") as any;
  return textBlock ? JSON.parse(textBlock.text) : {};
}

/**
 * Refine a template-generated system prompt: tighten wording for voice,
 * anticipate likely caller questions for this specific business, and keep
 * every factual detail intact.
 */
export async function refinePrompt(business: BusinessProfile, draftPrompt: string): Promise<string> {
  const response = await getClient().messages.create({
    model: config.factoryModel,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "user",
        content: `Below is a system prompt for an AI *phone* receptionist for "${business.name}" (${business.industry}). Improve it:

- Keep the exact same section structure, the {{NOW}} placeholder, and ALL factual details (hours, prices, services, policies) byte-for-byte accurate.
- Sharpen the persona so it feels like a receptionist this specific kind of business would actually hire.
- In the "Common questions" section, add 3-6 additional Q&As that callers to this type of business predictably ask, answered ONLY from facts already present (or answered with "offer to take a message" when the prompt lacks the fact).
- Keep it tight: this prompt is re-sent on every conversational turn of a live phone call.

Return ONLY the improved prompt text, no commentary.

---
${draftPrompt}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const improved = textBlock && "text" in textBlock ? textBlock.text.trim() : "";
  // Guard: the refined prompt must keep the dynamic time placeholder.
  if (!improved || !improved.includes("{{NOW}}")) return draftPrompt;
  return improved;
}
