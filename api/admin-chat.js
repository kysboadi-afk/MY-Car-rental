// api/admin-chat.js
// SLYTRANS Fleet Control — AI Admin Assistant chat endpoint.
// Connects to OpenAI using function-calling (tool use) and routes all tool
// calls through api/_admin-actions.js — no direct database access here.
//
// POST /api/admin-chat
// Body: {
//   secret:    string,          // ADMIN_SECRET
//   messages:  ChatMessage[],   // conversation history (role/content pairs)
//   auto_mode: boolean,         // optional — if true, AI may execute destructive actions
// }
//
// Response: { reply: string, tool_calls: string[], messages: ChatMessage[] }
//
// Required env vars:
//   ADMIN_SECRET   — admin password
//   OPENAI_API_KEY — OpenAI API key
// Optional:
//   OPENAI_MODEL   — model ID override (default: gpt-4o-mini)

import OpenAI from "openai";
import { isAdminAuthorized } from "./_admin-auth.js";
import { executeAction } from "./_admin-actions.js";
import { TOOL_DEFINITIONS } from "../lib/tools.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const MAX_TOOL_ROUNDS = 6; // prevent infinite tool-call loops

const SYSTEM_PROMPT = `You are the SLY Rides AI Business Assistant — an intelligent operations manager for a Los Angeles car rental company.

You have access to real-time business data through tools. Use them to answer admin questions accurately.

Fleet:
- Slingshot R: $300/day, $150 deposit
- Slingshot R (Unit 2 & 3): $350/day
- Camry 2012: $50/day, $300/week
- Camry 2013 SE: $55/day, $350/week

Capabilities:
- Retrieve revenue, bookings, vehicle data
- Detect business problems (slow periods, underperforming vehicles)
- Score bookings for fraud risk
- Add or update vehicles (requires confirmation)
- Send SMS messages (requires confirmation)

Tone: Professional, direct, data-driven. Always cite numbers when available.
When asked to take a destructive action (add vehicle, change pricing, send SMS), explain what you'll do and ask for confirmation before proceeding.
When the admin confirms an action, immediately retry the SAME tool call with confirmed: true added to the arguments. Do NOT ask for confirmation again.
Never fabricate data — always use tools to fetch real information.`;

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server configuration error: OPENAI_API_KEY is not set." });
  }

  const body = req.body || {};
  const { secret, messages: clientMessages, auto_mode: autoMode = false } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!Array.isArray(clientMessages) || clientMessages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // Validate message structure
  const validRoles = new Set(["user", "assistant", "tool", "system"]);
  for (const m of clientMessages) {
    if (!m || !validRoles.has(m.role)) {
      return res.status(400).json({ error: `Invalid message role: ${m?.role}` });
    }
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model  = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // Build message list (system + history)
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...clientMessages,
  ];

  const toolCallsMade = [];

  // ── Agentic loop ─────────────────────────────────────────────────────────
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      });
    } catch (err) {
      console.error("admin-chat: OpenAI error:", err);
      return res.status(500).json({ error: `OpenAI error: ${err.message}` });
    }

    const choice = completion.choices[0];
    const msg    = choice.message;

    // Append the assistant turn to the running message list
    messages.push(msg);

    // If no tool calls, we're done
    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      // Return the final text response and updated messages (minus system prompt)
      return res.status(200).json({
        reply:       msg.content || "",
        tool_calls:  toolCallsMade,
        messages:    messages.slice(1), // strip system prompt before returning
      });
    }

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      let args;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      toolCallsMade.push(toolName);

      let toolResult;
      try {
        // Pass requireConfirmation=true unless autoMode is explicitly on
        toolResult = await executeAction(toolName, args, { requireConfirmation: !autoMode });
      } catch (err) {
        toolResult = { error: err.message };
      }

      // Append tool result for the next OpenAI round
      messages.push({
        role:          "tool",
        tool_call_id:  tc.id,
        content:       JSON.stringify(toolResult),
      });

      // When the action is waiting for confirmation, add an explicit system-level
      // reminder so the AI knows exactly what to do once the admin confirms.
      if (toolResult.requires_confirmation) {
        messages.push({
          role:    "system",
          content: "The admin needs to confirm the above action. Once they confirm, call the SAME tool again with confirmed: true in the arguments. Do not re-explain or ask again — just execute.",
        });
      }
    }
  }

  // Fallback if loop exhausted
  return res.status(200).json({
    reply:      "I reached the maximum number of tool-call rounds. Please try a more specific question.",
    tool_calls: toolCallsMade,
    messages:   messages.slice(1),
  });
}
