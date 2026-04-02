// api/admin-chat.js
// SLY RIDES Admin AI — full-capability admin assistant.
//
// Architecture:
//   • This file owns auth, OpenAI communication, and tool dispatch ONLY.
//   • ALL database access is routed through api/_admin-actions.js (the actions
//     layer). admin-chat.js has zero direct Supabase access.
//   • _admin-actions.js validates inputs, confirms destructive operations, and
//     logs every action.
//
// POST /api/admin-chat
// Body: { secret, message, history: [{role, content}] }
// Returns: { reply, toolCalls: [{name, args, result}] }

import OpenAI from "openai";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { openAIErrorMessage } from "./_error-helpers.js";
import { executeAction, VEHICLE_NAMES, STATUS_LABELS } from "./_admin-actions.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const MAX_TOOL_ROUNDS  = 12;
const MAX_HISTORY_MSGS = 24;

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `You are the SLY RIDES Admin AI for SLY Transportation Services, a Los Angeles car rental company. Today is ${today}.

You are a smart interface to the admin backend — not a direct database controller. Every action you take goes through validated, predefined backend functions. You cannot run raw queries or bypass the backend's safety rules.

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

RULES:
  - Always call a tool to fetch live data before answering — never guess numbers.
  - Format tables and lists clearly using plain text.
  - If a tool returns requiresConfirmation: true, show the warning message to the
    admin and ask them to confirm before calling the tool again with confirmed: true.
  - For write operations, summarise exactly what changed after the tool succeeds.
  - If a tool returns an error, explain it clearly and suggest next steps.`;
}

// ─── Tool definitions (OpenAI function-calling schema) ────────────────────────

const TOOLS = [
  { type:"function", function:{ name:"get_financial_summary", description:"Complete P&L summary: total revenue, refunds, net revenue, expenses, and profit broken down by vehicle and period.", parameters:{ type:"object", properties:{ period:{ type:"string", description:"today | week | month | quarter | year | all (default: month)" }, vehicle_id:{ type:"string", description:"Optional: filter to one vehicle" } }, required:[] } } },
  { type:"function", function:{ name:"query_revenue", description:"Query individual revenue records. Each record represents one rental payment.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, from_date:{ type:"string", description:"YYYY-MM-DD" }, to_date:{ type:"string", description:"YYYY-MM-DD" }, payment_status:{ type:"string", description:"paid | partial | unpaid" }, is_no_show:{ type:"boolean" }, limit:{ type:"number", description:"default 30 max 100" } }, required:[] } } },
  { type:"function", function:{ name:"query_expenses", description:"Query expense records: maintenance, insurance, fuel, repair, registration, other.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, from_date:{ type:"string" }, to_date:{ type:"string" }, category:{ type:"string", description:"maintenance | insurance | repair | fuel | registration | other" }, limit:{ type:"number" } }, required:[] } } },
  { type:"function", function:{ name:"add_expense", description:"Record a new expense for a vehicle.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, amount:{ type:"number" }, category:{ type:"string", description:"maintenance | insurance | repair | fuel | registration | other" }, description:{ type:"string" }, expense_date:{ type:"string", description:"YYYY-MM-DD, defaults to today" } }, required:["vehicle_id","amount","category","description"] } } },
  { type:"function", function:{ name:"delete_expense", description:"Permanently delete an expense record. Requires confirmed: true.", parameters:{ type:"object", properties:{ expense_id:{ type:"string" }, confirmed:{ type:"boolean", description:"Must be true to execute the deletion." } }, required:["expense_id"] } } },
  { type:"function", function:{ name:"query_bookings", description:"List and filter bookings.", parameters:{ type:"object", properties:{ status:{ type:"string", description:"pending | approved | active | completed | cancelled" }, vehicle_id:{ type:"string" }, search:{ type:"string", description:"name, phone, email, or booking ref" }, from_date:{ type:"string" }, to_date:{ type:"string" }, limit:{ type:"number", description:"default 20 max 50" } }, required:[] } } },
  { type:"function", function:{ name:"get_booking", description:"Full details of a single booking by reference or UUID.", parameters:{ type:"object", properties:{ booking_ref:{ type:"string" }, id:{ type:"string" } }, required:[] } } },
  { type:"function", function:{ name:"update_booking", description:"Update a booking: status, notes, payments, or return date.", parameters:{ type:"object", properties:{ booking_ref:{ type:"string" }, id:{ type:"string" }, status:{ type:"string", description:"pending | approved | active | completed | cancelled" }, notes:{ type:"string" }, cancel_reason:{ type:"string" }, amount_paid:{ type:"number" }, total_price:{ type:"number" }, return_date:{ type:"string" }, return_time:{ type:"string" }, payment_method:{ type:"string" } }, required:[] } } },
  { type:"function", function:{ name:"create_booking", description:"Create a new manual booking for a cash or offline reservation.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, customer_name:{ type:"string" }, phone:{ type:"string" }, email:{ type:"string" }, pickup_date:{ type:"string" }, pickup_time:{ type:"string" }, return_date:{ type:"string" }, return_time:{ type:"string" }, amount_paid:{ type:"number" }, notes:{ type:"string" } }, required:["vehicle_id","customer_name","pickup_date","return_date"] } } },
  { type:"function", function:{ name:"query_customers", description:"List or search customers.", parameters:{ type:"object", properties:{ search:{ type:"string" }, flagged:{ type:"boolean" }, banned:{ type:"boolean" }, risk_flag:{ type:"string", description:"low | medium | high" }, limit:{ type:"number" } }, required:[] } } },
  { type:"function", function:{ name:"get_customer", description:"Full customer profile + booking history.", parameters:{ type:"object", properties:{ id:{ type:"string" }, phone:{ type:"string" }, email:{ type:"string" } }, required:[] } } },
  { type:"function", function:{ name:"update_customer", description:"Update customer: name, email, risk flag, notes, flagged/banned status.", parameters:{ type:"object", properties:{ id:{ type:"string" }, full_name:{ type:"string" }, email:{ type:"string" }, risk_flag:{ type:"string", description:"low | medium | high" }, flagged:{ type:"boolean" }, banned:{ type:"boolean" }, flag_reason:{ type:"string" }, ban_reason:{ type:"string" }, notes:{ type:"string" } }, required:["id"] } } },
  { type:"function", function:{ name:"query_vehicles", description:"All fleet vehicles with full data: name, year, status, pricing, mileage.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"get_fleet_status", description:"Live online/offline availability of each vehicle on the booking websites.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"set_vehicle_availability", description:"Toggle a vehicle on/off for online bookings. available=false puts vehicle in maintenance mode.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, available:{ type:"boolean" } }, required:["vehicle_id","available"] } } },
  { type:"function", function:{ name:"update_vehicle", description:"Update vehicle details: purchase price, date, vehicle name, year, status, or cover image.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, vehicle_name:{ type:"string" }, vehicle_year:{ type:"number" }, purchase_price:{ type:"number" }, purchase_date:{ type:"string" }, status:{ type:"string", description:"active | inactive | sold" }, cover_image:{ type:"string" } }, required:["vehicle_id"] } } },
  { type:"function", function:{ name:"get_blocked_dates", description:"All blocked/unavailable date ranges per vehicle.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" } }, required:[] } } },
  { type:"function", function:{ name:"block_dates", description:"Block a date range so customers cannot book a vehicle on those dates.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, from:{ type:"string", description:"YYYY-MM-DD" }, to:{ type:"string", description:"YYYY-MM-DD" }, reason:{ type:"string" } }, required:["vehicle_id","from","to"] } } },
  { type:"function", function:{ name:"unblock_dates", description:"Remove a blocked date range, re-opening those dates for booking.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, from:{ type:"string" }, to:{ type:"string" } }, required:["vehicle_id","from","to"] } } },
  { type:"function", function:{ name:"get_site_settings", description:"All public website settings: contact info, social media, hero text, policies, promo banner.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"update_site_settings", description:"Update public website settings. Goes live on both Slingshot and Camry sites immediately.", parameters:{ type:"object", properties:{ settings:{ type:"object", description:"Key-value pairs. Keys: business_name, phone, whatsapp, email, instagram_url, facebook_url, tiktok_url, twitter_url, promo_banner_enabled, promo_banner_text, hero_title, hero_subtitle, about_text, policies_cancellation, policies_damage, policies_fuel, policies_age, service_area_notes, pickup_instructions", additionalProperties:{ type:"string" } } }, required:["settings"] } } },
  { type:"function", function:{ name:"get_system_settings", description:"System configuration: pricing rates, deposit amounts, tax rates, extension settings.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"update_system_setting", description:"Update one system/pricing setting. Changes affect the live booking website.", parameters:{ type:"object", properties:{ category:{ type:"string", description:"pricing | tax | operational" }, key:{ type:"string" }, value:{ type:"string" } }, required:["category","key","value"] } } },
  { type:"function", function:{ name:"get_sms_templates", description:"All automated SMS message templates used to communicate with customers.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"update_sms_template", description:"Update an SMS template body or enable/disable it.", parameters:{ type:"object", properties:{ template_key:{ type:"string" }, message:{ type:"string" }, enabled:{ type:"boolean" } }, required:["template_key"] } } },
  { type:"function", function:{ name:"get_content_blocks", description:"FAQs, announcements, and testimonials on the public website.", parameters:{ type:"object", properties:{ type:{ type:"string", description:"faq | announcement | testimonial" } }, required:[] } } },
  { type:"function", function:{ name:"manage_content_block", description:"Create, update, or delete a FAQ, announcement, or testimonial. Delete requires confirmed: true. title is required when creating.", parameters:{ type:"object", properties:{ action:{ type:"string", description:"create | update | delete" }, block_id:{ type:"string" }, type:{ type:"string", description:"faq | announcement | testimonial" }, title:{ type:"string", description:"Required when action is create." }, body:{ type:"string" }, active:{ type:"boolean" }, sort_order:{ type:"number" }, author_name:{ type:"string" }, author_location:{ type:"string" }, expires_at:{ type:"string" }, confirmed:{ type:"boolean", description:"Required true when action is delete." } }, required:["action"] } } },
  { type:"function", function:{ name:"query_protection_plans", description:"List all protection/damage coverage plans offered to renters.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"manage_protection_plan", description:"Create, update, or delete a protection plan. Delete requires confirmed: true.", parameters:{ type:"object", properties:{ action:{ type:"string", description:"create | update | delete" }, id:{ type:"string" }, name:{ type:"string" }, description:{ type:"string" }, daily_rate:{ type:"number" }, liability_cap:{ type:"number" }, is_active:{ type:"boolean" }, sort_order:{ type:"number" }, confirmed:{ type:"boolean", description:"Required true when action is delete." } }, required:["action"] } } },
  { type:"function", function:{ name:"query_waitlist", description:"View the waitlist queue. Shows customers waiting for a vehicle.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, status:{ type:"string", description:"pending | approved | declined" } }, required:[] } } },
  { type:"function", function:{ name:"get_analytics", description:"Comprehensive fleet analytics: bookings, revenue, utilization, and per-vehicle breakdown.", parameters:{ type:"object", properties:{ period:{ type:"string", description:"today | week | month | quarter | year | all (default: month)" } }, required:[] } } },
  { type:"function", function:{ name:"get_dashboard", description:"Live dashboard overview: pending approvals, today pickups, today returns, overdue rentals.", parameters:{ type:"object", properties:{}, required:[] } } },
];

// ─── Chat loop ────────────────────────────────────────────────────────────────

async function runChat(messages, toolCalls) {
  let currentMessages = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model:       OPENAI_MODEL,
      messages:    currentMessages,
      tools:       TOOLS,
      tool_choice: "auto",
    });

    const assistantMsg = response.choices[0]?.message;
    if (!assistantMsg) {
      console.warn("[admin-chat] unexpected Chat Completions shape:", JSON.stringify(response.choices?.slice(0, 1)));
      return "";
    }

    // No tool calls → return the text reply.
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return assistantMsg.content || "";
    }

    // Add the assistant message (with tool_calls) to the conversation.
    currentMessages.push(assistantMsg);

    // Dispatch each tool call through the actions layer — no direct DB access here.
    const results = await Promise.all(assistantMsg.tool_calls.map(async tc => {
      let callArgs = {};
      try { callArgs = JSON.parse(tc.function.arguments || "{}"); } catch (e) {
        console.warn(`[admin-chat] failed to parse arguments for tool ${tc.function.name}:`, e.message);
      }
      const result = await executeAction(tc.function.name, callArgs);
      toolCalls.push({ name: tc.function.name, args: callArgs, result });
      return { role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) };
    }));

    // Add tool results to the conversation for the next round.
    currentMessages.push(...results);
  }

  return "I reached the action limit for this request. Please break your request into smaller steps.";
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });
  if (!isAdminConfigured())    return res.status(500).json({ error: "ADMIN_SECRET is not configured." });

  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) return res.status(401).json({ error: "Unauthorized" });
  if (!(process.env.OPENAI_API_KEY || "").trim()) return res.status(503).json({ error: "AI assistant unavailable: OPENAI_API_KEY is not configured.", disabled: true });

  const rawMessage = String(body.message || "").trim();
  if (rawMessage.length > 4000) return res.status(400).json({ error: "Message is too long (max 4 000 characters). Please shorten your request." });
  if (!rawMessage) return res.status(400).json({ error: "message is required." });

  const history  = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_MSGS) : [];
  const messages = [
    { role: "system",  content: buildSystemPrompt() },
    ...history.filter(m => m.role && m.content && m.role !== "system").map(m => ({ role: m.role, content: String(m.content) })),
    { role: "user", content: rawMessage },
  ];
  const toolCalls = [];

  try {
    const reply = await runChat(messages, toolCalls);
    return res.status(200).json({ reply, toolCalls });
  } catch (err) {
    console.error("[admin-chat] error:", err);
    return res.status(500).json({ error: openAIErrorMessage(err) });
  }
}
