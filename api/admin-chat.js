// api/admin-chat.js
// SLY RIDES Admin AI — natural language access to every admin operation.
// Full read/write access to Supabase live data + GitHub-backed data.
// Changes go live on both Slingshot and Camry websites immediately.
//
// POST /api/admin-chat
// Body: { secret, message, history: [{role, content}] }
// Returns: { reply, toolCalls: [{name, args, result}] }

import crypto from "crypto";
import OpenAI from "openai";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { openAIErrorMessage } from "./_error-helpers.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_TOOL_ROUNDS  = 12;
const MAX_HISTORY_MSGS = 24;
const GITHUB_REPO      = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";

const ALLOWED_VEHICLES = ["slingshot","slingshot2","slingshot3","camry","camry2013"];
const VEHICLE_NAMES = {
  slingshot:  "Slingshot R",
  slingshot2: "Slingshot R (Unit 2)",
  slingshot3: "Slingshot R (Unit 3)",
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
};
const STATUS_LABELS = {
  pending:   "Pending (reserved, unpaid)",
  approved:  "Approved (booked/paid)",
  active:    "Active (vehicle out)",
  completed: "Completed (returned)",
  cancelled: "Cancelled",
};

// Build the system prompt fresh on every request so the date is always current.
function buildSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `You are the SLY RIDES Admin AI — the complete assistant for SLY Transportation Services, a Los Angeles car rental company. You have FULL live access to everything built on this platform from day one.

LIVE WEBSITE CONNECTIONS:
- Both websites (Slingshot site + Camry economy site) are powered by the same Supabase database.
- Any change you make goes live immediately on both websites.

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

FULL CAPABILITIES (use the provided tools):
  FINANCE & REPORTING
    get_financial_summary  -- P&L: revenue, expenses, net profit by period and vehicle
    query_revenue          -- every revenue record (gross, refunds, net, payment method)
    query_expenses         -- every expense (maintenance, fuel, insurance, repair, etc.)
    add_expense            -- record a new expense
    delete_expense         -- remove an expense record

  BOOKINGS
    query_bookings         -- list/filter bookings (status, vehicle, date, search)
    get_booking            -- full details of one booking
    update_booking         -- change status, notes, payment info, return date
    create_booking         -- create a new manual booking

  CUSTOMERS
    query_customers        -- list/search customers (flagged, banned, risk level)
    get_customer           -- full customer profile + booking history
    update_customer        -- update risk flag, notes, name, flagged/banned status

  VEHICLES & FLEET
    query_vehicles         -- all vehicle records and data
    get_fleet_status       -- which vehicles are live/offline on the website
    set_vehicle_availability -- toggle a vehicle on/off for online bookings
    update_vehicle         -- update vehicle details (price, status, name, year)

  CALENDAR & AVAILABILITY
    get_blocked_dates      -- view all blocked date ranges
    block_dates            -- block dates so a vehicle cannot be booked
    unblock_dates          -- re-open blocked dates

  WEBSITE CONTENT (both sites update live)
    get_site_settings      -- all public website text, contact info, social links, policies
    update_site_settings   -- update what appears on the websites
    get_system_settings    -- pricing rates, tax rates, operational config
    update_system_setting  -- change a pricing or config value

  COMMUNICATIONS
    get_sms_templates      -- all SMS automation templates
    update_sms_template    -- edit or enable/disable an SMS template
    get_content_blocks     -- FAQs, announcements, testimonials on the public site
    manage_content_block   -- create, update, or delete a content block

  PROTECTION PLANS
    query_protection_plans -- list all coverage tiers
    manage_protection_plan -- create, update, or delete a plan

  WAITLIST
    query_waitlist         -- view waitlist queue (pending, approved, declined)

  ANALYTICS & DASHBOARD
    get_analytics          -- full fleet analytics, utilization, revenue breakdown
    get_dashboard          -- live dashboard: pending approvals, today pickups/returns, overdue

RULES:
  - ALWAYS call a tool to fetch data before answering -- never guess or make up numbers.
  - For write operations confirm exactly what was changed in plain language.
  - Format tables and lists clearly using plain text.
  - If a tool returns an error, explain it clearly and suggest next steps.
  - Today's date is ${today}.`;
}

const TOOLS = [
  { type:"function", function:{ name:"get_financial_summary", description:"Complete P&L summary: total revenue, refunds, net revenue, expenses, and profit broken down by vehicle and period.", parameters:{ type:"object", properties:{ period:{ type:"string", description:"today | week | month | quarter | year | all (default: month)" }, vehicle_id:{ type:"string", description:"Optional: filter to one vehicle" } }, required:[] } } },
  { type:"function", function:{ name:"query_revenue", description:"Query individual revenue records. Each record represents one rental payment.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, from_date:{ type:"string", description:"YYYY-MM-DD" }, to_date:{ type:"string", description:"YYYY-MM-DD" }, payment_status:{ type:"string", description:"paid | partial | unpaid" }, is_no_show:{ type:"boolean" }, limit:{ type:"number", description:"default 30 max 100" } }, required:[] } } },
  { type:"function", function:{ name:"query_expenses", description:"Query expense records: maintenance, insurance, fuel, repair, registration, other.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, from_date:{ type:"string" }, to_date:{ type:"string" }, category:{ type:"string", description:"maintenance | insurance | repair | fuel | registration | other" }, limit:{ type:"number" } }, required:[] } } },
  { type:"function", function:{ name:"add_expense", description:"Record a new expense for a vehicle. Saved to the live database immediately.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, amount:{ type:"number" }, category:{ type:"string", description:"maintenance | insurance | repair | fuel | registration | other" }, description:{ type:"string" }, expense_date:{ type:"string", description:"YYYY-MM-DD, defaults to today" } }, required:["vehicle_id","amount","category","description"] } } },
  { type:"function", function:{ name:"delete_expense", description:"Delete an expense record permanently by expense_id.", parameters:{ type:"object", properties:{ expense_id:{ type:"string" } }, required:["expense_id"] } } },
  { type:"function", function:{ name:"query_bookings", description:"List and filter bookings.", parameters:{ type:"object", properties:{ status:{ type:"string", description:"pending | approved | active | completed | cancelled" }, vehicle_id:{ type:"string" }, search:{ type:"string", description:"name, phone, email, or booking ref" }, from_date:{ type:"string" }, to_date:{ type:"string" }, limit:{ type:"number", description:"default 20 max 50" } }, required:[] } } },
  { type:"function", function:{ name:"get_booking", description:"Full details of a single booking by reference or UUID.", parameters:{ type:"object", properties:{ booking_ref:{ type:"string" }, id:{ type:"string" } }, required:[] } } },
  { type:"function", function:{ name:"update_booking", description:"Update a booking: status, notes, payments, or return date.", parameters:{ type:"object", properties:{ booking_ref:{ type:"string" }, id:{ type:"string" }, status:{ type:"string", description:"pending | approved | active | completed | cancelled" }, notes:{ type:"string" }, cancel_reason:{ type:"string" }, amount_paid:{ type:"number" }, total_price:{ type:"number" }, return_date:{ type:"string" }, return_time:{ type:"string" }, payment_method:{ type:"string" } }, required:[] } } },
  { type:"function", function:{ name:"create_booking", description:"Create a new manual booking for a cash or offline reservation.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, customer_name:{ type:"string" }, phone:{ type:"string" }, email:{ type:"string" }, pickup_date:{ type:"string" }, pickup_time:{ type:"string" }, return_date:{ type:"string" }, return_time:{ type:"string" }, amount_paid:{ type:"number" }, notes:{ type:"string" } }, required:["vehicle_id","customer_name","pickup_date","return_date"] } } },
  { type:"function", function:{ name:"query_customers", description:"List or search customers.", parameters:{ type:"object", properties:{ search:{ type:"string" }, flagged:{ type:"boolean" }, banned:{ type:"boolean" }, risk_flag:{ type:"string", description:"low | medium | high" }, limit:{ type:"number" } }, required:[] } } },
  { type:"function", function:{ name:"get_customer", description:"Full customer profile + booking history.", parameters:{ type:"object", properties:{ id:{ type:"string" }, phone:{ type:"string" }, email:{ type:"string" } }, required:[] } } },
  { type:"function", function:{ name:"update_customer", description:"Update customer: name, email, risk flag, notes, flagged/banned status.", parameters:{ type:"object", properties:{ id:{ type:"string" }, full_name:{ type:"string" }, email:{ type:"string" }, risk_flag:{ type:"string", description:"low | medium | high" }, flagged:{ type:"boolean" }, banned:{ type:"boolean" }, flag_reason:{ type:"string" }, ban_reason:{ type:"string" }, notes:{ type:"string" } }, required:["id"] } } },
  { type:"function", function:{ name:"query_vehicles", description:"All fleet vehicles with full data: name, year, status, pricing, mileage.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"get_fleet_status", description:"Live online/offline availability of each vehicle on the booking websites.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"set_vehicle_availability", description:"Toggle a vehicle on/off for online bookings. available=false hides it from the live website immediately.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, available:{ type:"boolean" } }, required:["vehicle_id","available"] } } },
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
  { type:"function", function:{ name:"manage_content_block", description:"Create, update, or delete a FAQ, announcement, or testimonial on the public website.", parameters:{ type:"object", properties:{ action:{ type:"string", description:"create | update | delete" }, block_id:{ type:"string" }, type:{ type:"string", description:"faq | announcement | testimonial" }, title:{ type:"string" }, body:{ type:"string" }, active:{ type:"boolean" }, sort_order:{ type:"number" }, author_name:{ type:"string" }, author_location:{ type:"string" }, expires_at:{ type:"string" } }, required:["action"] } } },
  { type:"function", function:{ name:"query_protection_plans", description:"List all protection/damage coverage plans offered to renters.", parameters:{ type:"object", properties:{}, required:[] } } },
  { type:"function", function:{ name:"manage_protection_plan", description:"Create, update, or delete a protection plan.", parameters:{ type:"object", properties:{ action:{ type:"string", description:"create | update | delete" }, id:{ type:"string" }, name:{ type:"string" }, description:{ type:"string" }, daily_rate:{ type:"number" }, liability_cap:{ type:"number" }, is_active:{ type:"boolean" }, sort_order:{ type:"number" } }, required:["action"] } } },
  { type:"function", function:{ name:"query_waitlist", description:"View the waitlist queue. Shows customers waiting for a vehicle.", parameters:{ type:"object", properties:{ vehicle_id:{ type:"string" }, status:{ type:"string", description:"pending | approved | declined" } }, required:[] } } },
  { type:"function", function:{ name:"get_analytics", description:"Comprehensive fleet analytics: bookings, revenue, utilization, and per-vehicle breakdown.", parameters:{ type:"object", properties:{ period:{ type:"string", description:"today | week | month | quarter | year | all (default: month)" } }, required:[] } } },
  { type:"function", function:{ name:"get_dashboard", description:"Live dashboard overview: pending approvals, today pickups, today returns, overdue rentals.", parameters:{ type:"object", properties:{}, required:[] } } },
];

// Responses API uses a flattened tool format (no nested `function` object).
const RESPONSE_TOOLS = TOOLS.map(({ function: fn }) => ({
  type: "function",
  name: fn.name,
  description: fn.description,
  parameters: fn.parameters,
}));

const ALLOWED_SETTINGS_KEYS = new Set([
  "business_name","phone","whatsapp","email",
  "instagram_url","facebook_url","tiktok_url","twitter_url",
  "promo_banner_enabled","promo_banner_text",
  "hero_title","hero_subtitle","about_text",
  "policies_cancellation","policies_damage","policies_fuel","policies_age",
  "service_area_notes","pickup_instructions",
]);

function ghHeaders() {
  const h = { Accept:"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghReadJson(path, fallback = null) {
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { headers: ghHeaders() });
    if (!r.ok) return fallback;
    const f = await r.json();
    return JSON.parse(Buffer.from(f.content.replace(/\n/g, ""), "base64").toString("utf-8"));
  } catch { return fallback; }
}

function periodToFromDate(period) {
  const now = new Date();
  if (period === "today")   return now.toISOString().split("T")[0];
  if (period === "week")    { const d = new Date(now); d.setDate(d.getDate() - 7);    return d.toISOString().split("T")[0]; }
  if (period === "month")   { const d = new Date(now); d.setDate(d.getDate() - 30);   return d.toISOString().split("T")[0]; }
  if (period === "quarter") { const d = new Date(now); d.setDate(d.getDate() - 90);   return d.toISOString().split("T")[0]; }
  if (period === "year")    { const d = new Date(now); d.setFullYear(d.getFullYear()-1); return d.toISOString().split("T")[0]; }
  return null;
}

function r2(n) { return Math.round(Number(n||0)*100)/100; }

async function executeTool(name, args, sb) {
  try {
    switch (name) {

      case "get_financial_summary": {
        const fromDate = periodToFromDate(args.period || "month");
        let rq = sb.from("revenue_records").select("vehicle_id,gross_amount,refund_amount,deposit_amount,net,is_no_show,is_cancelled,payment_method,rental_date");
        if (fromDate) rq = rq.gte("rental_date", fromDate);
        if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) rq = rq.eq("vehicle_id", args.vehicle_id);
        let eq = sb.from("expenses").select("vehicle_id,amount,category,date");
        if (fromDate) eq = eq.gte("date", fromDate);
        if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) eq = eq.eq("vehicle_id", args.vehicle_id);
        const [revRes, expRes] = await Promise.all([rq, eq]);
        if (revRes.error) return { error: revRes.error.message };
        if (expRes.error) return { error: expRes.error.message };
        const revenues = revRes.data || [];
        const expenses = expRes.data || [];
        const vMap = {};
        for (const vid of ALLOWED_VEHICLES) vMap[vid] = { vehicle:VEHICLE_NAMES[vid], bookings:0, gross:0, refunds:0, net_revenue:0, expenses:0, profit:0, no_shows:0, cancelled:0 };
        for (const r of revenues) {
          if (!vMap[r.vehicle_id]) continue;
          const v = vMap[r.vehicle_id]; v.bookings++;
          if (r.is_no_show)   { v.no_shows++;  continue; }
          if (r.is_cancelled) { v.cancelled++; continue; }
          v.gross       += Number(r.gross_amount  || 0);
          v.refunds     += Number(r.refund_amount || 0);
          v.net_revenue += Number(r.gross_amount  || 0) - Number(r.refund_amount || 0);
        }
        for (const e of expenses) { if (vMap[e.vehicle_id]) vMap[e.vehicle_id].expenses += Number(e.amount||0); }
        for (const v of Object.values(vMap)) { v.profit = v.net_revenue - v.expenses; for (const k of ["gross","refunds","net_revenue","expenses","profit"]) v[k] = r2(v[k]); }
        const totals = Object.values(vMap).reduce((a,v) => { a.gross+=v.gross; a.refunds+=v.refunds; a.net_revenue+=v.net_revenue; a.expenses+=v.expenses; a.profit+=v.profit; a.bookings+=v.bookings; return a; }, {gross:0,refunds:0,net_revenue:0,expenses:0,profit:0,bookings:0});
        for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
        const expByCat = {};
        for (const e of expenses) expByCat[e.category] = r2((expByCat[e.category]||0) + Number(e.amount||0));
        return { period: args.period||"month", from_date: fromDate||"all time", totals, by_vehicle: Object.values(vMap), expense_by_category: expByCat };
      }

      case "query_revenue": {
        let q = sb.from("revenue_records").select("id,booking_ref,vehicle_id,gross_amount,refund_amount,deposit_amount,net,payment_method,payment_status,is_paid,is_no_show,is_cancelled,notes,rental_date,created_at").order("rental_date",{ascending:false}).limit(Math.min(Number(args.limit)||30,100));
        if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
        if (args.from_date)  q = q.gte("rental_date", args.from_date);
        if (args.to_date)    q = q.lte("rental_date", args.to_date);
        if (args.payment_status) q = q.eq("payment_status", args.payment_status);
        if (typeof args.is_no_show === "boolean") q = q.eq("is_no_show", args.is_no_show);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const records = (data||[]).map(r => ({ ...r, vehicle_name: VEHICLE_NAMES[r.vehicle_id]||r.vehicle_id }));
        return { count: records.length, total_gross: r2(records.reduce((s,r)=>s+Number(r.gross_amount||0),0)), total_net: r2(records.reduce((s,r)=>s+Number(r.net||(r.gross_amount-r.refund_amount)||0),0)), records };
      }

      case "query_expenses": {
        let q = sb.from("expenses").select("expense_id,vehicle_id,date,category,amount,notes,created_at").order("date",{ascending:false}).limit(Math.min(Number(args.limit)||30,100));
        if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
        if (args.from_date) q = q.gte("date", args.from_date);
        if (args.to_date)   q = q.lte("date", args.to_date);
        if (args.category)  q = q.eq("category", args.category);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const expenses = (data||[]).map(e => ({ ...e, vehicle_name: VEHICLE_NAMES[e.vehicle_id]||e.vehicle_id }));
        return { count: expenses.length, total_amount: r2(expenses.reduce((s,e)=>s+Number(e.amount||0),0)), expenses };
      }

      case "add_expense": {
        const CATS = ["maintenance","insurance","repair","fuel","registration","other"];
        if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
        if (!CATS.includes(args.category)) return { error: `category must be one of: ${CATS.join(", ")}` };
        const amount = Number(args.amount);
        if (isNaN(amount) || amount <= 0) return { error: "amount must be a positive number." };
        const expense = { expense_id: crypto.randomBytes(8).toString("hex"), vehicle_id: args.vehicle_id, date: args.expense_date||new Date().toISOString().split("T")[0], category: args.category, amount: r2(amount), notes: String(args.description||"").slice(0,500), created_at: new Date().toISOString() };
        const { error } = await sb.from("expenses").insert(expense);
        if (error) return { error: error.message };
        return { success: true, expense: { ...expense, vehicle_name: VEHICLE_NAMES[expense.vehicle_id] } };
      }

      case "delete_expense": {
        if (!args.expense_id) return { error: "expense_id is required." };
        const { data: existing } = await sb.from("expenses").select("expense_id,vehicle_id,amount,category").eq("expense_id", args.expense_id).maybeSingle();
        if (!existing) return { error: "Expense not found." };
        const { error } = await sb.from("expenses").delete().eq("expense_id", args.expense_id);
        if (error) return { error: error.message };
        return { success: true, deleted: existing };
      }

      case "query_bookings": {
        let q = sb.from("bookings").select("id,booking_ref,vehicle_id,status,pickup_date,pickup_time,return_date,return_time,amount_paid,total_price,payment_status,notes,created_at,customers(full_name,phone,email)").order("created_at",{ascending:false}).limit(Math.min(Number(args.limit)||20,50));
        if (args.status) q = q.eq("status", args.status);
        if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
        if (args.from_date) q = q.gte("pickup_date", args.from_date);
        if (args.to_date)   q = q.lte("pickup_date", args.to_date);
        if (args.search) {
          const s = args.search.trim().replace(/'/g, "''");
          // Find matching customer IDs first, then OR with booking_ref search
          const { data: cust } = await sb.from("customers").select("id")
            .or(`full_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`)
            .limit(50);
          const custIds = (cust||[]).map(c => c.id).filter(Boolean);
          let orClause = `booking_ref.ilike.%${s}%`;
          if (custIds.length) orClause += `,customer_id.in.(${custIds.join(",")})`;
          q = q.or(orClause);
        }
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: (data||[]).length, bookings: (data||[]).map(b => ({ id:b.id, booking_ref:b.booking_ref, vehicle:VEHICLE_NAMES[b.vehicle_id]||b.vehicle_id, vehicle_id:b.vehicle_id, status:b.status, status_label:STATUS_LABELS[b.status]||b.status, customer_name:b.customers?.full_name||"—", customer_phone:b.customers?.phone||"—", customer_email:b.customers?.email||"—", pickup_date:b.pickup_date, pickup_time:b.pickup_time, return_date:b.return_date, return_time:b.return_time, amount_paid:b.amount_paid, total_price:b.total_price, payment_status:b.payment_status, notes:b.notes, created_at:b.created_at })) };
      }

      case "get_booking": {
        if (!args.booking_ref && !args.id) return { error: "Provide booking_ref or id." };
        let q = sb.from("bookings").select("*,customers(full_name,phone,email,driver_license,risk_flag,flagged,banned,no_show_count,notes)");
        if (args.booking_ref) q = q.eq("booking_ref", args.booking_ref); else q = q.eq("id", args.id);
        const { data, error } = await q.single();
        if (error) return { error: error.message };
        return { booking: { ...data, vehicle_name: VEHICLE_NAMES[data.vehicle_id]||data.vehicle_id, status_label: STATUS_LABELS[data.status]||data.status } };
      }

      case "update_booking": {
        if (!args.booking_ref && !args.id) return { error: "Provide booking_ref or id." };
        const validStatuses = ["pending","approved","active","completed","cancelled"];
        if (args.status && !validStatuses.includes(args.status)) return { error: `status must be one of: ${validStatuses.join(", ")}` };
        const updates = { updated_at: new Date().toISOString() };
        if (args.status)         updates.status         = args.status;
        if (args.notes !== undefined) updates.notes     = String(args.notes).slice(0,1000);
        if (args.cancel_reason)  updates.cancel_reason  = String(args.cancel_reason).slice(0,500);
        if (typeof args.amount_paid === "number") updates.amount_paid = args.amount_paid;
        if (typeof args.total_price === "number") updates.total_price = args.total_price;
        if (args.return_date)   updates.return_date   = args.return_date;
        if (args.return_time)   updates.return_time   = args.return_time;
        if (args.payment_method) updates.payment_method = args.payment_method;
        let q = sb.from("bookings").update(updates);
        if (args.booking_ref) q = q.eq("booking_ref", args.booking_ref); else q = q.eq("id", args.id);
        const { data, error } = await q.select().single();
        if (error) return { error: error.message };
        if (args.status && data?.vehicle_id) {
          const rsMap = { pending:"available", approved:"reserved", active:"rented", completed:"available", cancelled:"available" };
          const rs = rsMap[args.status];
          if (rs) await sb.from("vehicles").update({ rental_status:rs, updated_at:new Date().toISOString() }).eq("vehicle_id", data.vehicle_id);
        }
        return { success: true, booking: { ...data, vehicle_name: VEHICLE_NAMES[data.vehicle_id], status_label: STATUS_LABELS[data.status] } };
      }

      case "create_booking": {
        if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
        if (!args.customer_name) return { error: "customer_name is required." };
        if (!args.pickup_date || !args.return_date) return { error: "pickup_date and return_date are required." };
        let customerId = null;
        if (args.phone || args.email) {
          const phone = args.phone ? String(args.phone).replace(/\D/g,"") : null;
          let cq = sb.from("customers").select("id");
          if (phone) cq = cq.eq("phone", phone); else cq = cq.eq("email", args.email);
          const { data: existing } = await cq.maybeSingle();
          if (existing) { customerId = existing.id; }
          else {
            const { data: nc } = await sb.from("customers").insert({ full_name:args.customer_name, phone:phone||null, email:args.email||null, created_at:new Date().toISOString() }).select("id").single();
            customerId = nc?.id || null;
          }
        }
        const bookingRef = "SLY-" + crypto.randomBytes(3).toString("hex").toUpperCase();
        const booking = { booking_ref:bookingRef, vehicle_id:args.vehicle_id, customer_id:customerId, status:"approved", pickup_date:args.pickup_date, pickup_time:args.pickup_time||null, return_date:args.return_date, return_time:args.return_time||null, amount_paid:args.amount_paid||0, total_price:args.amount_paid||0, payment_method:"cash", payment_status:args.amount_paid?"paid":"unpaid", notes:args.notes?String(args.notes).slice(0,1000):"Manual booking", created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
        const { data, error } = await sb.from("bookings").insert(booking).select().single();
        if (error) return { error: error.message };
        await sb.from("blocked_dates").insert({ vehicle_id:args.vehicle_id, from_date:args.pickup_date, to_date:args.return_date, reason:"Manual booking "+bookingRef, created_at:new Date().toISOString() }).select();
        return { success: true, booking: { ...data, vehicle_name: VEHICLE_NAMES[data.vehicle_id] } };
      }

      case "query_customers": {
        let q = sb.from("customers").select("id,full_name,phone,email,driver_license,risk_flag,flagged,banned,flag_reason,ban_reason,no_show_count,notes,created_at").order("created_at",{ascending:false}).limit(Math.min(Number(args.limit)||20,50));
        if (typeof args.flagged === "boolean") q = q.eq("flagged", args.flagged);
        if (typeof args.banned  === "boolean") q = q.eq("banned",  args.banned);
        if (args.risk_flag) q = q.eq("risk_flag", args.risk_flag);
        if (args.search)    q = q.or(`full_name.ilike.%${args.search.trim().replace(/'/g,"''")}%,phone.ilike.%${args.search.trim().replace(/'/g,"''")}%,email.ilike.%${args.search.trim().replace(/'/g,"''")}%`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: (data||[]).length, customers: data||[] };
      }

      case "get_customer": {
        if (!args.id && !args.phone && !args.email) return { error: "Provide id, phone, or email." };
        let q = sb.from("customers").select("*,bookings(booking_ref,vehicle_id,status,pickup_date,return_date,amount_paid,total_price)");
        if (args.id) q = q.eq("id", args.id); else if (args.phone) q = q.eq("phone", args.phone); else q = q.eq("email", args.email);
        const { data, error } = await q.single();
        if (error) return { error: error.message };
        return { customer: data };
      }

      case "update_customer": {
        if (!args.id) return { error: "Customer id is required." };
        const allowed = ["full_name","email","risk_flag","flagged","banned","flag_reason","ban_reason","notes","driver_license"];
        const updates = { updated_at: new Date().toISOString() };
        for (const f of allowed) { if (args[f] !== undefined) updates[f] = args[f]; }
        if (updates.risk_flag && !["low","medium","high"].includes(updates.risk_flag)) return { error: "risk_flag must be low, medium, or high." };
        const { data, error } = await sb.from("customers").update(updates).eq("id", args.id).select().single();
        if (error) return { error: error.message };
        return { success: true, customer: data };
      }

      case "query_vehicles": {
        const { data, error } = await sb.from("vehicles").select("vehicle_id,data,rental_status,updated_at").order("vehicle_id");
        if (error) return { error: error.message };
        return { vehicles: (data||[]).map(v => ({ vehicle_id:v.vehicle_id, display_name:VEHICLE_NAMES[v.vehicle_id]||v.vehicle_id, rental_status:v.rental_status, available:v.rental_status==="available", updated_at:v.updated_at, ...(v.data||{}) })) };
      }

      case "get_fleet_status": {
        const { data, error } = await sb.from("vehicles").select("vehicle_id,rental_status,updated_at").order("vehicle_id");
        if (error) return { error: error.message };
        return { fleet: (data||[]).map(v => ({ vehicle_id:v.vehicle_id, name:VEHICLE_NAMES[v.vehicle_id]||v.vehicle_id, rental_status:v.rental_status, available:v.rental_status==="available", updated_at:v.updated_at })) };
      }

      case "set_vehicle_availability": {
        if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
        if (typeof args.available !== "boolean") return { error: "available must be true or false." };
        const rental_status = args.available ? "available" : "maintenance";
        const { error } = await sb.from("vehicles").update({ rental_status, updated_at:new Date().toISOString() }).eq("vehicle_id", args.vehicle_id);
        if (error) return { error: error.message };
        return { success:true, vehicle_id:args.vehicle_id, vehicle_name:VEHICLE_NAMES[args.vehicle_id], available:args.available, rental_status };
      }

      case "update_vehicle": {
        if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
        const ALLOWED_V = ["purchase_price","purchase_date","status","vehicle_name","vehicle_year","cover_image"];
        const safe = {};
        for (const f of ALLOWED_V) {
          if (args[f] === undefined) continue;
          if (f === "status" && !["active","inactive","sold"].includes(args[f])) return { error: "status must be active, inactive, or sold." };
          safe[f] = args[f];
        }
        if (!Object.keys(safe).length) return { error: "No valid fields to update." };
        const { data: existing } = await sb.from("vehicles").select("data").eq("vehicle_id", args.vehicle_id).maybeSingle();
        const merged = { ...(existing?.data||{}), ...safe };
        const { error } = await sb.from("vehicles").update({ data:merged, updated_at:new Date().toISOString() }).eq("vehicle_id", args.vehicle_id);
        if (error) return { error: error.message };
        return { success:true, vehicle_id:args.vehicle_id, updated:safe };
      }

      case "get_blocked_dates": {
        let q = sb.from("blocked_dates").select("id,vehicle_id,from_date,to_date,reason,created_at").order("from_date");
        if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count:(data||[]).length, blocked_dates:(data||[]).map(r=>({ ...r, vehicle_name:VEHICLE_NAMES[r.vehicle_id]||r.vehicle_id })) };
      }

      case "block_dates": {
        if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
        if (!args.from || !args.to) return { error: "from and to are required." };
        if (args.from > args.to) return { error: "from must be on or before to." };
        const record = { vehicle_id:args.vehicle_id, from_date:args.from, to_date:args.to, reason:args.reason?String(args.reason).slice(0,200):null, created_at:new Date().toISOString() };
        const { data, error } = await sb.from("blocked_dates").insert(record).select().single();
        if (error) return { error: error.message };
        return { success:true, blocked:{ ...data, vehicle_name:VEHICLE_NAMES[data.vehicle_id] } };
      }

      case "unblock_dates": {
        if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
        if (!args.from || !args.to) return { error: "from and to are required." };
        const { data, error } = await sb.from("blocked_dates").delete().eq("vehicle_id",args.vehicle_id).eq("from_date",args.from).eq("to_date",args.to).select();
        if (error) return { error: error.message };
        return { success:true, removed:(data||[]).length, vehicle_name:VEHICLE_NAMES[args.vehicle_id] };
      }

      case "get_site_settings": {
        const { data, error } = await sb.from("site_settings").select("key,value").order("key");
        if (error) return { error: error.message };
        const settings = {};
        for (const row of (data||[])) settings[row.key] = row.value;
        return { settings };
      }

      case "update_site_settings": {
        const raw = args.settings || {};
        const safe = {};
        for (const [k,v] of Object.entries(raw)) { if (ALLOWED_SETTINGS_KEYS.has(k)) safe[k] = v===null?null:String(v); }
        if (!Object.keys(safe).length) return { error: "No valid settings keys provided." };
        const rows = Object.entries(safe).map(([key,value]) => ({ key, value, updated_at:new Date().toISOString() }));
        const { error } = await sb.from("site_settings").upsert(rows,{ onConflict:"key" });
        if (error) return { error: error.message };
        return { success:true, updated:safe };
      }

      case "get_system_settings": {
        const { data, error } = await sb.from("system_settings").select("category,key,value,updated_at").order("category").order("key");
        if (error) return { error: error.message };
        const grouped = {};
        for (const r of (data||[])) { if (!grouped[r.category]) grouped[r.category]={}; grouped[r.category][r.key]=r.value; }
        return { system_settings:grouped };
      }

      case "update_system_setting": {
        const { category, key, value } = args;
        if (!category||!key||value===undefined) return { error: "category, key, and value are required." };
        const { error } = await sb.from("system_settings").upsert({ category, key, value:String(value), updated_at:new Date().toISOString() },{ onConflict:"category,key" });
        if (error) return { error: error.message };
        return { success:true, category, key, value:String(value) };
      }

      case "get_sms_templates": {
        const { data, error } = await sb.from("sms_template_overrides").select("template_key,message,enabled,updated_at").order("template_key");
        if (error) return { error: error.message };
        return { templates: data||[] };
      }

      case "update_sms_template": {
        const { template_key, message, enabled } = args;
        if (!template_key) return { error: "template_key is required." };
        const record = { template_key, updated_at:new Date().toISOString() };
        if (typeof message === "string")  record.message = message.slice(0,1000);
        if (typeof enabled === "boolean") record.enabled = enabled;
        if (!record.message && record.enabled===undefined) return { error: "Provide message or enabled." };
        const { data, error } = await sb.from("sms_template_overrides").upsert(record,{ onConflict:"template_key" }).select().single();
        if (error) return { error: error.message };
        return { success:true, template:data };
      }

      case "get_content_blocks": {
        let q = sb.from("content_blocks").select("block_id,type,title,body,active,sort_order,author_name,author_location,expires_at,created_at,updated_at").order("sort_order");
        if (args.type) q = q.eq("type", args.type);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count:(data||[]).length, blocks:data||[] };
      }

      case "manage_content_block": {
        const BT = ["faq","announcement","testimonial"];
        const BF = new Set(["type","title","body","author_name","author_location","sort_order","active","expires_at"]);
        const { action } = args;
        if (action === "create") {
          if (!BT.includes(args.type)) return { error: `type must be one of: ${BT.join(", ")}` };
          const block = { block_id:crypto.randomUUID(), created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
          for (const f of BF) { if (args[f]!==undefined) block[f]=args[f]; }
          if (block.active===undefined) block.active=true;
          if (block.sort_order===undefined) block.sort_order=0;
          const { data, error } = await sb.from("content_blocks").insert(block).select().single();
          if (error) return { error: error.message };
          return { success:true, block:data };
        }
        if (action === "update") {
          if (!args.block_id) return { error: "block_id is required for update." };
          const updates = { updated_at:new Date().toISOString() };
          for (const f of BF) { if (args[f]!==undefined) updates[f]=args[f]; }
          const { data, error } = await sb.from("content_blocks").update(updates).eq("block_id",args.block_id).select().single();
          if (error) return { error: error.message };
          return { success:true, block:data };
        }
        if (action === "delete") {
          if (!args.block_id) return { error: "block_id is required for delete." };
          const { error } = await sb.from("content_blocks").delete().eq("block_id",args.block_id);
          if (error) return { error: error.message };
          return { success:true, deleted_block_id:args.block_id };
        }
        return { error: `Unknown action: ${action}` };
      }

      case "query_protection_plans": {
        const { data, error } = await sb.from("protection_plans").select("*").order("sort_order").order("name");
        if (error) return { error: error.message };
        return { plans: data||[] };
      }

      case "manage_protection_plan": {
        const { action } = args;
        if (action === "create") {
          if (!args.name) return { error: "name is required." };
          const plan = { name:args.name, description:args.description||null, daily_rate:Number(args.daily_rate||0), liability_cap:Number(args.liability_cap||0), is_active:args.is_active??true, sort_order:Number(args.sort_order||0), created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
          const { data, error } = await sb.from("protection_plans").insert(plan).select().single();
          if (error) return { error: error.message };
          return { success:true, plan:data };
        }
        if (action === "update") {
          if (!args.id) return { error: "id is required for update." };
          const updates = { updated_at:new Date().toISOString() };
          for (const f of ["name","description","daily_rate","liability_cap","is_active","sort_order"]) { if (args[f]!==undefined) updates[f]=args[f]; }
          const { data, error } = await sb.from("protection_plans").update(updates).eq("id",args.id).select().single();
          if (error) return { error: error.message };
          return { success:true, plan:data };
        }
        if (action === "delete") {
          if (!args.id) return { error: "id is required for delete." };
          const { error } = await sb.from("protection_plans").delete().eq("id",args.id);
          if (error) return { error: error.message };
          return { success:true, deleted_id:args.id };
        }
        return { error: `Unknown action: ${action}` };
      }

      case "query_waitlist": {
        const data = await ghReadJson("waitlist.json", {});
        const entries = [];
        for (const [vehicleId, list] of Object.entries(data)) {
          if (!Array.isArray(list)) continue;
          for (const entry of list) {
            if (args.vehicle_id && vehicleId !== args.vehicle_id) continue;
            if (args.status && entry.status !== args.status) continue;
            entries.push({ ...entry, vehicle_id:vehicleId, vehicle_name:VEHICLE_NAMES[vehicleId]||vehicleId });
          }
        }
        entries.sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
        return { count:entries.length, waitlist:entries };
      }

      case "get_analytics": {
        const fromDate = periodToFromDate(args.period || "month");
        let bq = sb.from("bookings").select("id,vehicle_id,status,pickup_date,return_date,amount_paid,total_price");
        if (fromDate) bq = bq.gte("pickup_date", fromDate);
        const [bRes, rRes, eRes] = await Promise.all([
          bq,
          sb.from("revenue_records").select("vehicle_id,gross_amount,net,is_no_show,is_cancelled").gte("rental_date", fromDate||"2000-01-01"),
          sb.from("expenses").select("vehicle_id,amount").gte("date", fromDate||"2000-01-01"),
        ]);
        const bookings = bRes.data||[]; const revenue = rRes.data||[]; const expenses = eRes.data||[];
        const vMap = {};
        for (const vid of ALLOWED_VEHICLES) vMap[vid] = { name:VEHICLE_NAMES[vid], bookings:0, active:0, completed:0, revenue:0, expenses:0 };
        const statusCounts = {};
        for (const b of bookings) {
          statusCounts[b.status] = (statusCounts[b.status]||0)+1;
          if (vMap[b.vehicle_id]) { vMap[b.vehicle_id].bookings++; if (b.status==="active") vMap[b.vehicle_id].active++; if (b.status==="completed") vMap[b.vehicle_id].completed++; }
        }
        for (const r of revenue)  { if (vMap[r.vehicle_id]&&!r.is_no_show&&!r.is_cancelled) vMap[r.vehicle_id].revenue  += Number(r.gross_amount||0); }
        for (const e of expenses) { if (vMap[e.vehicle_id]) vMap[e.vehicle_id].expenses += Number(e.amount||0); }
        const totalRevenue  = revenue.filter(r=>!r.is_no_show&&!r.is_cancelled).reduce((s,r)=>s+Number(r.gross_amount||0),0);
        const totalExpenses = expenses.reduce((s,e)=>s+Number(e.amount||0),0);
        return { period:args.period||"month", from_date:fromDate||"all time", total_bookings:bookings.length, status_breakdown:statusCounts, total_revenue:r2(totalRevenue), total_expenses:r2(totalExpenses), net_profit:r2(totalRevenue-totalExpenses), by_vehicle:Object.values(vMap).map(v=>({ ...v, revenue:r2(v.revenue), expenses:r2(v.expenses), profit:r2(v.revenue-v.expenses) })) };
      }

      case "get_dashboard": {
        const today = new Date().toISOString().split("T")[0];
        const [pendingRes, pickupsRes, returnsRes, overdueRes] = await Promise.all([
          sb.from("bookings").select("id,booking_ref,vehicle_id,customers(full_name,phone)").eq("status","pending").order("created_at",{ascending:false}).limit(20),
          sb.from("bookings").select("id,booking_ref,vehicle_id,pickup_time,customers(full_name,phone)").eq("status","approved").eq("pickup_date",today).limit(20),
          sb.from("bookings").select("id,booking_ref,vehicle_id,return_time,customers(full_name,phone)").eq("status","active").eq("return_date",today).limit(20),
          sb.from("bookings").select("id,booking_ref,vehicle_id,return_date,customers(full_name,phone)").eq("status","active").lt("return_date",today).limit(20),
        ]);
        const fmt = rows => (rows||[]).map(b=>({ booking_ref:b.booking_ref, vehicle:VEHICLE_NAMES[b.vehicle_id]||b.vehicle_id, customer:b.customers?.full_name||"—", phone:b.customers?.phone||"—", pickup_time:b.pickup_time, return_time:b.return_time, return_date:b.return_date }));
        return { today, pending_approvals:{ count:(pendingRes.data||[]).length, items:fmt(pendingRes.data) }, pickups_today:{ count:(pickupsRes.data||[]).length, items:fmt(pickupsRes.data) }, returns_today:{ count:(returnsRes.data||[]).length, items:fmt(returnsRes.data) }, overdue:{ count:(overdueRes.data||[]).length, items:fmt(overdueRes.data) } };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`[admin-chat] tool ${name} threw:`, err);
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

async function runChat(messages, toolCalls, sb) {
  // Separate the system prompt (sent as `instructions`) from the conversation input.
  // buildSystemPrompt() always injects exactly one system message at position 0.
  const instructions = messages.find(m => m.role === "system")?.content || "";
  const inputMessages = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role, content: m.content }));

  let input = inputMessages;
  let previousResponseId = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const params = {
      model: OPENAI_MODEL,
      instructions,
      input,
      tools: RESPONSE_TOOLS,
    };
    if (previousResponseId) params.previous_response_id = previousResponseId;

    const response = await client.responses.create(params);
    previousResponseId = response.id;

    const fnCalls = response.output.filter(item => item.type === "function_call");
    if (fnCalls.length === 0) {
      const msgItem = response.output.find(item => item.type === "message");
      const text = msgItem?.content?.find(c => c.type === "output_text")?.text;
      if (text === undefined) console.warn("[admin-chat] unexpected Responses API shape — no output_text found:", JSON.stringify(response.output?.slice(0,2)));
      return text || "";
    }

    const results = await Promise.all(fnCalls.map(async tc => {
      let callArgs = {};
      try { callArgs = JSON.parse(tc.arguments || "{}"); } catch (e) {
        console.warn(`[admin-chat] failed to parse arguments for tool ${tc.name}:`, e.message);
      }
      const result = await executeTool(tc.name, callArgs, sb);
      toolCalls.push({ name: tc.name, args: callArgs, result });
      return { type: "function_call_output", call_id: tc.call_id, output: JSON.stringify(result) };
    }));

    // Subsequent rounds only need tool results; prior context is carried via previous_response_id.
    input = results;
  }

  return "I reached the action limit for this request. Please break your request into smaller steps.";
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
