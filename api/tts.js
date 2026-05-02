// api/tts.js
// SLYTRANS Fleet Control — Text-to-Speech proxy endpoint.
// Converts text to audio using OpenAI's TTS API and streams the result.
//
// POST /api/tts
// Body: { text: string, lang?: string, secret: string }
// Response: audio/mpeg stream
//
// Required env vars:
//   ADMIN_SECRET   — admin password
//   OPENAI_API_KEY — OpenAI API key

import OpenAI from "openai";
import { isAdminAuthorized } from "./_admin-auth.js";

const ALLOWED_ORIGINS = [
  "https://www.slytrans.com",
  "https://slytrans.com",
];

const MAX_TEXT_LENGTH = 1000;
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "alloy";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const headers = corsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const { text, lang = "en", secret } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    res.writeHead(401, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (!text || typeof text !== "string") {
    res.writeHead(400, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "text is required" }));
    return;
  }

  const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH);
  if (!trimmed) {
    res.writeHead(400, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "text must not be empty" }));
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.writeHead(503, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OpenAI API key not configured" }));
    return;
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Build language instruction for the TTS model
    const langInstruction = lang === "es"
      ? "Speak in Spanish."
      : "Speak in English.";

    const mp3 = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: `[${langInstruction}] ${trimmed}`,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    res.writeHead(200, {
      ...headers,
      "Content-Type": "audio/mpeg",
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch (err) {
    console.error("[tts] OpenAI error:", err);
    const status = err.status || 500;
    res.writeHead(status, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "TTS failed" }));
  }
}
