// api/admin-chat.js
// SLY RIDES Admin AI — smart conversational interface for the admin panel.
// Provides a safe, prompt-based AI assistant. Backend action integrations
// (bookings, pricing, fleet, etc.) will be connected once basic chat is stable.
//
// POST /api/admin-chat
// Body: { secret, message, history: [{role, content}] }
// Returns: { reply, toolCalls: [] }

import OpenAI from "openai";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { openAIErrorMessage } from "./_error-helpers.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_HISTORY_MSGS = 24;

// Build the system prompt fresh on every request so the date is always current.
function buildSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `You are the SLY RIDES Admin AI assistant for SLY Transportation Services, a Los Angeles car rental company. Today is ${today}.

You help the admin understand the business, answer questions, and guide them through management tasks.

FLEET (5 vehicles):
  slingshot  -> Slingshot R            (Slingshot site)
  slingshot2 -> Slingshot R (Unit 2)   (Slingshot site)
  slingshot3 -> Slingshot R (Unit 3)   (Slingshot site)
  camry      -> Camry 2012             (Economy site)
  camry2013  -> Camry 2013 SE          (Economy site)

BOOKING STATUS VALUES:
  pending   = reserved but not yet paid
  approved  = confirmed and paid
  active    = vehicle currently with the renter
  completed = rental ended, vehicle returned
  cancelled = booking cancelled

Provide clear, concise, and helpful responses. If you need live data to answer a question accurately, say so — live backend integrations will be connected soon.`;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error:"Method not allowed" });
  if (!isAdminConfigured())    return res.status(500).json({ error:"ADMIN_SECRET is not configured." });
  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) return res.status(401).json({ error:"Unauthorized" });
  if (!(process.env.OPENAI_API_KEY || "").trim()) return res.status(503).json({ error:"AI assistant unavailable: OPENAI_API_KEY is not configured.", disabled:true });
  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error:"Supabase is not configured. The AI assistant requires a live database connection." });
  // Cap incoming message at 4 000 characters and return a helpful error if exceeded
  const rawMessage = String(body.message||"").trim();
  if (rawMessage.length > 4000) {
    return res.status(400).json({ error: "Message is too long (max 4 000 characters). Please shorten your request." });
  }
  const userMessage = rawMessage;
  if (!userMessage) return res.status(400).json({ error:"message is required." });
  const history  = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_MSGS) : [];
  const messages = [{ role:"system", content:buildSystemPrompt() }, ...history.filter(m=>m.role&&m.content), { role:"user", content:userMessage }];
  const toolCalls = [];
  try {
    const reply = await runChat(messages, toolCalls, sb);
    return res.status(200).json({ reply, toolCalls });
  } catch (err) {
    console.error("[admin-chat] error:", err);
    return res.status(500).json({ error: openAIErrorMessage(err) });
  }
}
