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

const MAX_TOOL_ROUNDS = 6; // prevent infinite tool-call loops

const SYSTEM_PROMPT = `You are the SLY Rides AI Business Assistant — an intelligent operations manager for a Los Angeles car rental company.

You have access to real-time business data through tools. Use them to answer admin questions accurately. Never fabricate data — always use tools to fetch real information.

## What you can read and answer questions about

**Dashboard & Overview**
- Use get_insights for business KPIs, detected problems, revenue trends, and booking statistics.

**Vehicles**
- Use get_vehicles for fleet list, status, pricing, booking counts, Bouncie tracking status, and decision badges.

**Reservations & Bookings (including Raw Bookings)**
- Use get_bookings to list/filter bookings by vehicle, status, or all. Works for all booking views.

**Fleet Status & Mileage**
- Use get_mileage for GPS odometer readings, maintenance status (oil/brakes/tires), and usage trends.

**Block Dates**
- Use get_blocked_dates to see which date ranges are blocked per vehicle (manual blocks + booking-based blocks).

**Finance — Expenses**
- Use get_expenses for cost records filtered by vehicle or category (maintenance, fuel, insurance, etc.).

**Finance — Revenue**
- Use get_revenue for revenue totals by month or all-time. Use get_analytics (action: "revenue_trend") for multi-month trends.

**Fleet Analytics**
- Use get_analytics for utilization rates, per-vehicle revenue performance, booking trend analysis.
  - action "fleet": overview of all vehicles ranked by revenue
  - action "vehicle" + vehicleId: deep-dive on a single vehicle
  - action "revenue_trend" + months: monthly revenue chart data

**Management — Customers**
- Use get_customers to list all customers, search by name/phone/email, or filter for flagged/banned customers.

**Management — Protection Plans**
- Use get_protection_plans to list all coverage tiers, daily add-on rates, and liability caps.

**Pricing — ALWAYS use tools, never guess**
- Use get_system_settings with category "pricing" to read live rates and deposit amounts.
  - category "pricing": all rate and deposit settings (daily, weekly, monthly, deposits)
  - category "tax": tax rates
  - category "automation": automation toggles
  - category "notification": SMS/email notification toggles
- Use get_price_quote to compute a rental total for a specific vehicle, dates, or duration.
  - For cars: provide vehicleId, pickup (YYYY-MM-DD), returnDate (YYYY-MM-DD)
  - For Slingshots: provide vehicleId and durationHours (3, 6, 24, 48, or 72)
  - ALWAYS call get_price_quote when the admin asks "how much for X days?" or any pricing question. Never calculate totals in your head — the system applies tiered rates (daily/weekly/monthly) and live tax that you cannot accurately reproduce manually.

**Communication — SMS Automation**
- Use get_sms_templates to see all SMS automation templates, their current message text, and enabled/disabled status.

**Fraud**
- Use get_fraud_report to score bookings for fraud risk.

## Actions you can take (all require confirmation)
- Create/update vehicles via create_vehicle / update_vehicle
- **Assign a Bouncie GPS device** to a vehicle via register_bouncie_device (see guided flow below)
- Change booking status via update_booking_status
- Record maintenance via mark_maintenance
- Flag bookings via flag_booking
- Send SMS via send_sms or send_message_to_driver
- Record vehicle decisions via confirm_vehicle_action / update_action_status

## Registering a Bouncie device (guided flow)

When the admin says anything like "register Bouncie device", "assign GPS tracker", "add IMEI", or "set up Bouncie", follow this exact flow:

Step 1 — Ask for the IMEI:
> "What is the 15-digit IMEI printed on the Bouncie device?"

Step 2 — Validate IMEI immediately (before asking for vehicle):
- If the input is not exactly 15 digits (digits only, ignore spaces/dashes), say:
  "That doesn't look right — a Bouncie IMEI must be exactly 15 digits. Please double-check the number printed on the device."
  Then ask again.

Step 3 — Ask which vehicle to assign it to:
> "Which vehicle should this device be assigned to?"
> (If the admin doesn't know the ID, call get_vehicles first to show the list, then ask.)

Step 4 — Show a confirmation summary and ask for approval:

---
**Bouncie Device Registration**
- Device IMEI: [imei]
- Vehicle: [vehicle name] (`[vehicleId]`)

Shall I assign this device?
---

Step 5 — Only call register_bouncie_device with confirmed: true after the admin says yes.

After the tool returns:
- If sync_status is "awaiting_first_sync": Tell the admin the device is registered and waiting for the first GPS ping. This normally appears within a few minutes once the device is powered on and the car is driven briefly.
- If sync_status is "active": Confirm tracking is live and state the last sync time.
- If sync_status is "stale": Warn that the device hasn't synced recently and suggest checking that it is powered on.
- If the tool returns an error (duplicate IMEI, invalid format, vehicle not found): Relay the exact error message to the admin and ask them to correct it.

## Creating a new vehicle (guided flow)

When the admin asks to add or create a vehicle, collect ALL required fields one step at a time before calling create_vehicle:

1. Vehicle name (e.g. "Honda Civic 2015")
2. Daily rental price (must be > $0)
3. Purchase price — what was paid to acquire the vehicle (must be > $0)
4. Purchase date — when was it purchased? (format: YYYY-MM-DD)
5. Bouncie device IMEI — optional. Ask: "Do you want to assign a Bouncie GPS tracker? If so, what is the IMEI?"

Validation rules (reject and re-ask if violated):
- price_per_day must be a positive number
- purchase_price must be a positive number
- purchase_date must be a valid calendar date in YYYY-MM-DD format
- type must always be "car" — never "slingshot" (those are managed separately)

Do NOT call create_vehicle until all required fields are collected and valid.

Before calling create_vehicle, ALWAYS show a confirmation summary in this exact format and ask for approval:

---
**New Vehicle Summary**
- Name: [vehicle name]
- Daily Price: $[price]/day
- Purchase Price: $[purchase_price]
- Purchase Date: [purchase_date]
- Bouncie Device: [IMEI or "None — mileage tracking will not be active"]

Shall I create this vehicle?
---

Only call create_vehicle with confirmed: true after the admin says yes.

After creation:
- Call get_vehicles to verify the vehicle appears in the fleet
- If bouncie_device_id was provided, confirm tracking_active: true in the result
- If any warnings are returned, relay them to the admin

## Mileage & maintenance context
- Mileage tracking requires Bouncie GPS devices assigned to each car and the Bouncie integration configured in Vercel.
- If get_mileage returns bouncie_configured: false, explain that the Bouncie GPS integration is not yet set up and that the admin should configure BOUNCIE_ACCESS_TOKEN in Vercel.
- If get_mileage returns tracked_vehicles: 0 AND raw_bouncie_rows: 0, explain that no cars currently have a Bouncie device ID saved in the database (editable in the Fleet page under each vehicle's IMEI field).
- If get_mileage returns tracked_vehicles: 0 AND raw_bouncie_rows > 0, explain that Bouncie devices appear to be assigned only to slingshots, not to the car fleet.
- If get_mileage returns tracked_vehicles: 0 but the dashboard is showing mileage alerts, there may be a temporary sync lag — suggest the admin refresh or re-save the vehicle's Bouncie IMEI in the Fleet page.
- If get_mileage returns a note field, relay that note to the admin as the reason data is unavailable.
- If get_mileage returns an error field, describe it as a data retrieval issue and suggest the admin check server logs or Supabase configuration.
- Never describe a missing Bouncie configuration or empty vehicle list as a "system error" — these are setup/configuration states.

Tone: Professional, direct, data-driven. Always cite numbers when available.
When asked to take a destructive action (add vehicle, change pricing, send SMS), explain what you'll do and ask for confirmation before proceeding.
When the admin confirms an action, immediately retry the SAME tool call with confirmed: true added to the arguments. Do NOT ask for confirmation again.
Never fabricate data — always use tools to fetch real information.`;

// ── Confirmation-replay helpers ───────────────────────────────────────────────

/**
 * Scan a message list for the most recent unresolved requires_confirmation
 * tool result, then find the corresponding tool call's name and arguments.
 *
 * "Unresolved" means no successful tool result appeared after it.
 *
 * @param {object[]} messages
 * @returns {{ toolName: string, args: object } | null}
 */
function findPendingConfirmation(messages) {
  let pendingCallId = null;

  for (const m of messages) {
    if (m.role !== "tool") continue;
    let parsed;
    try { parsed = JSON.parse(m.content || "{}"); } catch { continue; }

    if (parsed.requires_confirmation) {
      // New unresolved confirmation found
      pendingCallId = m.tool_call_id;
    } else {
      // A successful tool result clears any earlier pending confirmation
      pendingCallId = null;
    }
  }

  if (!pendingCallId) return null;

  // Locate the assistant message that issued that tool call
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc.id !== pendingCallId) continue;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      return { toolName: tc.function.name, args };
    }
  }

  return null;
}

/**
 * Returns true when the admin text looks like a confirmation ("yes", "ok", etc.).
 * Deliberately narrow — we don't want false positives on normal queries.
 * Short-message guard (≤ 80 chars) avoids matching "okay, but what about...".
 */
function isConfirmation(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;
  return /\b(yes|yeah|yep|confirm|confirmed|proceed|do\s+it|go\s+ahead|approve|ok|okay|sure|absolutely)\b/i
    .test(trimmed);
}

/**
 * Build a human-readable success/failure reply for a confirmed tool execution.
 */
function formatConfirmedReply(toolName, args, result) {
  if (result.error) return `❌ Action failed: ${result.error}`;
  // Strip backticks/asterisks from dynamic values so they can't break markdown formatting
  const safe = (v) => String(v ?? "").replace(/[`*_[\]]/g, "");
  switch (toolName) {
    case "create_vehicle": {
      const warnings = result.warnings?.length
        ? `\n⚠️ ${result.warnings.join("\n⚠️ ")}`
        : "";
      return `✅ Vehicle **${safe(result.name)}** created successfully (ID: \`${safe(result.created)}\`).\n- Price: $${safe(result.price_per_day)}/day\n- Purchase: $${safe(result.purchase_price)} on ${safe(result.purchase_date)}\n- Tracking: ${result.tracking_active ? `✅ Bouncie assigned (${safe(result.bouncie_device_id)})` : "⚠️ No Bouncie device — assign one via update_vehicle to enable mileage tracking"}${warnings}`;
    }
    case "add_vehicle":
      return `✅ Vehicle **${safe(result.name)}** added successfully (ID: \`${safe(result.created)}\`).`;
    case "update_vehicle":
      return `✅ Vehicle \`${safe(args.vehicleId)}\` updated successfully.`;
    case "send_sms":
      return `✅ SMS sent to ${safe(args.phone)}.`;
    case "mark_maintenance":
      return `✅ ${safe(result.message || "Maintenance recorded.")}`;
    case "flag_booking":
      return `✅ Booking \`${safe(args.bookingId)}\` flagged.`;
    case "update_booking_status":
      return `✅ Booking \`${safe(args.bookingId)}\` status updated to **${safe(args.status)}**.`;
    case "confirm_vehicle_action":
      return `✅ ${safe(result.message || `Action recorded for ${args.vehicleId}.`)}`;
    case "update_action_status":
      return `✅ ${safe(result.message || `Action status updated for ${args.vehicleId}.`)}`;
    case "send_message_to_driver":
      return `✅ Message sent to driver of booking \`${safe(args.bookingId)}\` (${safe(result.to)}).`;
    case "register_bouncie_device": {
      const syncIcon = result.sync_status === "active"
        ? "✅ Tracking active"
        : result.sync_status === "stale"
          ? "⚠️ Device not syncing — check power"
          : "🕐 Awaiting first GPS sync";
      return (
        `✅ Bouncie device \`${safe(result.bouncie_device_id)}\` assigned to **${safe(result.vehicle_name)}**.\n` +
        `- Sync status: ${syncIcon}\n` +
        (result.last_synced_at
          ? `- Last sync: ${safe(result.last_synced_at)}\n`
          : `- No sync recorded yet — power on the device and drive briefly to trigger the first ping.\n`)
      );
    }
    default:
      return `✅ Action completed: ${JSON.stringify(result)}`;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {

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

  // ── Deterministic confirmation replay ────────────────────────────────────
  // If the history contains an unresolved requires_confirmation tool result
  // AND the latest user message is a simple confirmation, execute the pending
  // action directly without going through OpenAI. This guarantees the action
  // completes after exactly one confirmation regardless of AI behaviour.
  const lastUserMsg = [...clientMessages].reverse().find(m => m.role === "user");
  const pending = findPendingConfirmation(clientMessages);

  if (pending && lastUserMsg && isConfirmation(lastUserMsg.content)) {
    let toolResult;
    try {
      toolResult = await executeAction(
        pending.toolName,
        { ...pending.args, confirmed: true },
        { requireConfirmation: !autoMode },
      );
    } catch (err) {
      toolResult = { error: err.message };
    }

    const reply = formatConfirmedReply(pending.toolName, pending.args, toolResult);
    return res.status(200).json({
      reply,
      tool_calls:  [pending.toolName],
      messages:    [...clientMessages, { role: "assistant", content: reply }],
    });
  }

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
    }
  }

  // Fallback if loop exhausted
  return res.status(200).json({
    reply:      "I reached the maximum number of tool-call rounds. Please try a more specific question.",
    tool_calls: toolCallsMade,
    messages:   messages.slice(1),
  });

  } catch (err) {
    console.error("ADMIN CHAT CRASH:", err);
    return res.status(200).json({
      message: "⚠ Something went wrong, but the system is still running.",
      error: err.message,
    });
  }
}
