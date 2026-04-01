// api/_admin-actions.js
// Admin actions layer — the ONLY place that touches the database on behalf of
// the admin chatbot.  All chatbot tool calls are routed through executeAction().
//
// Responsibilities:
//   • Input validation for every action
//   • Confirmation gate for destructive (delete) operations
//   • Audit logging: every call is recorded in admin_action_logs + console
//   • All Supabase access is contained here — admin-chat.js has none

import crypto from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const ALLOWED_VEHICLES = ["slingshot","slingshot2","slingshot3","camry","camry2013"];

export const VEHICLE_NAMES = {
  slingshot:  "Slingshot R",
  slingshot2: "Slingshot R (Unit 2)",
  slingshot3: "Slingshot R (Unit 3)",
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
};

export const STATUS_LABELS = {
  pending:   "Pending (reserved, unpaid)",
  approved:  "Approved (booked/paid)",
  active:    "Active (vehicle out)",
  completed: "Completed (returned)",
  cancelled: "Cancelled",
};

const ALLOWED_SETTINGS_KEYS = new Set([
  "business_name","phone","whatsapp","email",
  "instagram_url","facebook_url","tiktok_url","twitter_url",
  "promo_banner_enabled","promo_banner_text",
  "hero_title","hero_subtitle","about_text",
  "policies_cancellation","policies_damage","policies_fuel","policies_age",
  "service_area_notes","pickup_instructions",
]);

const ALLOWED_SYSTEM_SETTING_CATEGORIES = ["pricing","tax","operational"];

// Maximum value length for site_settings rows (Supabase text column guard).
const MAX_SETTING_VALUE_LENGTH = 2000;

// Business rule: single expense entries above this amount are almost certainly
// a data entry error — require manual Supabase correction instead.
const MAX_EXPENSE_AMOUNT = 1_000_000;

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";

// Actions where confirmed:true is required before execution.
// Key format: "action_name" or "action_name:sub_action".
const DESTRUCTIVE_ACTIONS = new Set([
  "delete_expense",
  "manage_content_block:delete",
  "manage_protection_plan:delete",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r2(n) { return Math.round(Number(n || 0) * 100) / 100; }

function periodToFromDate(period) {
  const now = new Date();
  if (period === "today")   return now.toISOString().split("T")[0];
  if (period === "week")    { const d = new Date(now); d.setDate(d.getDate() - 7);       return d.toISOString().split("T")[0]; }
  if (period === "month")   { const d = new Date(now); d.setDate(d.getDate() - 30);      return d.toISOString().split("T")[0]; }
  if (period === "quarter") { const d = new Date(now); d.setDate(d.getDate() - 90);      return d.toISOString().split("T")[0]; }
  if (period === "year")    { const d = new Date(now); d.setFullYear(d.getFullYear()-1); return d.toISOString().split("T")[0]; }
  return null;
}

function isValidDate(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

// ─── GitHub read helper (read-only, for waitlist.json) ────────────────────────

async function ghReadJson(path, fallback = null) {
  try {
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { headers });
    if (!r.ok) return fallback;
    const f = await r.json();
    return JSON.parse(Buffer.from(f.content.replace(/\n/g, ""), "base64").toString("utf-8"));
  } catch { return fallback; }
}

// ─── Audit logging ────────────────────────────────────────────────────────────

async function logAction(name, args, result) {
  // Always log to console (visible in Vercel function logs).
  console.log("[admin-action]", JSON.stringify({ action: name, args, result_keys: Object.keys(result || {}) }));

  // Best-effort insert into admin_action_logs; silently ignore if table is absent.
  const sb = getSupabaseAdmin();
  if (!sb) return;
  try {
    await sb.from("admin_action_logs").insert({
      action_name: name,
      args: args ? JSON.parse(JSON.stringify(args)) : null,
      result: result ? JSON.parse(JSON.stringify(result)) : null,
    });
  } catch { /* non-fatal — table may not exist yet */ }
}

// ─── Confirmation helper ───────────────────────────────────────────────────────

function buildConfirmMessage(name, args) {
  if (name === "delete_expense") {
    return `⚠️ This will permanently delete expense ${args.expense_id}. Call this action again with confirmed: true to proceed.`;
  }
  if (name === "manage_content_block" && args.action === "delete") {
    return `⚠️ This will permanently delete content block ${args.block_id}. Call this action again with confirmed: true to proceed.`;
  }
  if (name === "manage_protection_plan" && args.action === "delete") {
    return `⚠️ This will permanently delete protection plan ${args.id}. Call this action again with confirmed: true to proceed.`;
  }
  return `⚠️ This is a destructive operation. Call this action again with confirmed: true to proceed.`;
}

function isDestructiveCall(name, args) {
  if (DESTRUCTIVE_ACTIONS.has(name)) return true;
  const subKey = `${name}:${args?.action}`;
  if (DESTRUCTIVE_ACTIONS.has(subKey)) return true;
  return false;
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Execute a named admin action.
 * All chatbot tool calls MUST go through here — never touch Supabase directly
 * from admin-chat.js.
 *
 * @param {string} name   - The action name matching a tool in admin-chat.js
 * @param {object} args   - Tool arguments from the AI
 * @returns {object}      - Result object (always a plain object, never throws)
 */
export async function executeAction(name, args = {}) {
  // Gate: destructive operations require explicit confirmation.
  if (isDestructiveCall(name, args) && !args.confirmed) {
    const msg = buildConfirmMessage(name, args);
    await logAction(name, args, { requiresConfirmation: true });
    return { requiresConfirmation: true, message: msg };
  }

  const sb = getSupabaseAdmin();
  if (!sb) return { error: "Database is not configured." };

  let result;
  try {
    result = await dispatch(name, args, sb);
  } catch (err) {
    console.error(`[admin-action] ${name} threw:`, err);
    result = { error: `Action ${name} failed: ${err.message}` };
  }

  // Fire-and-forget audit log (never blocks the response).
  logAction(name, args, result).catch(() => {});

  return result;
}

// ─── Action dispatcher ────────────────────────────────────────────────────────

async function dispatch(name, args, sb) {
  switch (name) {

    // ── Finance & reporting ──────────────────────────────────────────────────

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
      for (const vid of ALLOWED_VEHICLES) vMap[vid] = { vehicle: VEHICLE_NAMES[vid], bookings: 0, gross: 0, refunds: 0, net_revenue: 0, expenses: 0, profit: 0, no_shows: 0, cancelled: 0 };
      for (const r of revenues) {
        if (!vMap[r.vehicle_id]) continue;
        const v = vMap[r.vehicle_id]; v.bookings++;
        if (r.is_no_show)   { v.no_shows++;  continue; }
        if (r.is_cancelled) { v.cancelled++; continue; }
        v.gross       += Number(r.gross_amount  || 0);
        v.refunds     += Number(r.refund_amount || 0);
        v.net_revenue += Number(r.gross_amount  || 0) - Number(r.refund_amount || 0);
      }
      for (const e of expenses) { if (vMap[e.vehicle_id]) vMap[e.vehicle_id].expenses += Number(e.amount || 0); }
      for (const v of Object.values(vMap)) {
        v.profit = v.net_revenue - v.expenses;
        for (const k of ["gross","refunds","net_revenue","expenses","profit"]) v[k] = r2(v[k]);
      }
      const totals = Object.values(vMap).reduce((a, v) => {
        a.gross += v.gross; a.refunds += v.refunds; a.net_revenue += v.net_revenue;
        a.expenses += v.expenses; a.profit += v.profit; a.bookings += v.bookings;
        return a;
      }, { gross: 0, refunds: 0, net_revenue: 0, expenses: 0, profit: 0, bookings: 0 });
      for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
      const expByCat = {};
      for (const e of expenses) expByCat[e.category] = r2((expByCat[e.category] || 0) + Number(e.amount || 0));
      return { period: args.period || "month", from_date: fromDate || "all time", totals, by_vehicle: Object.values(vMap), expense_by_category: expByCat };
    }

    case "query_revenue": {
      let q = sb.from("revenue_records")
        .select("id,booking_ref,vehicle_id,gross_amount,refund_amount,deposit_amount,net,payment_method,payment_status,is_paid,is_no_show,is_cancelled,notes,rental_date,created_at")
        .order("rental_date", { ascending: false })
        .limit(Math.min(Number(args.limit) || 30, 100));
      if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
      if (args.from_date)  q = q.gte("rental_date", args.from_date);
      if (args.to_date)    q = q.lte("rental_date", args.to_date);
      if (args.payment_status) q = q.eq("payment_status", args.payment_status);
      if (typeof args.is_no_show === "boolean") q = q.eq("is_no_show", args.is_no_show);
      const { data, error } = await q;
      if (error) return { error: error.message };
      const records = (data || []).map(r => ({ ...r, vehicle_name: VEHICLE_NAMES[r.vehicle_id] || r.vehicle_id }));
      return {
        count: records.length,
        total_gross: r2(records.reduce((s, r) => s + Number(r.gross_amount || 0), 0)),
        total_net:   r2(records.reduce((s, r) => s + Number(r.net || (r.gross_amount - r.refund_amount) || 0), 0)),
        records,
      };
    }

    case "query_expenses": {
      let q = sb.from("expenses")
        .select("expense_id,vehicle_id,date,category,amount,notes,created_at")
        .order("date", { ascending: false })
        .limit(Math.min(Number(args.limit) || 30, 100));
      if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
      if (args.from_date) q = q.gte("date", args.from_date);
      if (args.to_date)   q = q.lte("date", args.to_date);
      if (args.category)  q = q.eq("category", args.category);
      const { data, error } = await q;
      if (error) return { error: error.message };
      const expenses = (data || []).map(e => ({ ...e, vehicle_name: VEHICLE_NAMES[e.vehicle_id] || e.vehicle_id }));
      return { count: expenses.length, total_amount: r2(expenses.reduce((s, e) => s + Number(e.amount || 0), 0)), expenses };
    }

    case "add_expense": {
      const CATS = ["maintenance","insurance","repair","fuel","registration","other"];
      if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
      if (!CATS.includes(args.category)) return { error: `category must be one of: ${CATS.join(", ")}` };
      const amount = Number(args.amount);
      if (isNaN(amount) || amount <= 0) return { error: "amount must be a positive number." };
      if (amount > MAX_EXPENSE_AMOUNT) return { error: `amount exceeds the allowed maximum of $${MAX_EXPENSE_AMOUNT.toLocaleString()}.` };
      const expenseDate = args.expense_date || new Date().toISOString().split("T")[0];
      if (!isValidDate(expenseDate)) return { error: "expense_date must be a valid YYYY-MM-DD date." };
      const expense = {
        expense_id:  crypto.randomBytes(8).toString("hex"),
        vehicle_id:  args.vehicle_id,
        date:        expenseDate,
        category:    args.category,
        amount:      r2(amount),
        notes:       String(args.description || "").slice(0, 500),
        created_at:  new Date().toISOString(),
      };
      const { error } = await sb.from("expenses").insert(expense);
      if (error) return { error: error.message };
      return { success: true, expense: { ...expense, vehicle_name: VEHICLE_NAMES[expense.vehicle_id] } };
    }

    case "delete_expense": {
      if (!args.expense_id) return { error: "expense_id is required." };
      const { data: existing } = await sb.from("expenses")
        .select("expense_id,vehicle_id,amount,category")
        .eq("expense_id", args.expense_id)
        .maybeSingle();
      if (!existing) return { error: "Expense not found." };
      const { error } = await sb.from("expenses").delete().eq("expense_id", args.expense_id);
      if (error) return { error: error.message };
      return { success: true, deleted: { ...existing, vehicle_name: VEHICLE_NAMES[existing.vehicle_id] || existing.vehicle_id } };
    }

    // ── Bookings ─────────────────────────────────────────────────────────────

    case "query_bookings": {
      let q = sb.from("bookings")
        .select("id,booking_ref,vehicle_id,status,pickup_date,pickup_time,return_date,return_time,amount_paid,total_price,payment_status,notes,created_at,customers(full_name,phone,email)")
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(args.limit) || 20, 50));
      if (args.status) q = q.eq("status", args.status);
      if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
      if (args.from_date) q = q.gte("pickup_date", args.from_date);
      if (args.to_date)   q = q.lte("pickup_date", args.to_date);
      if (args.search) {
        const s = args.search.trim().replace(/'/g, "''");
        const { data: cust } = await sb.from("customers").select("id")
          .or(`full_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`)
          .limit(50);
        const custIds = (cust || []).map(c => c.id).filter(Boolean);
        let orClause = `booking_ref.ilike.%${s}%`;
        if (custIds.length) orClause += `,customer_id.in.(${custIds.join(",")})`;
        q = q.or(orClause);
      }
      const { data, error } = await q;
      if (error) return { error: error.message };
      return {
        count: (data || []).length,
        bookings: (data || []).map(b => ({
          id: b.id, booking_ref: b.booking_ref,
          vehicle: VEHICLE_NAMES[b.vehicle_id] || b.vehicle_id, vehicle_id: b.vehicle_id,
          status: b.status, status_label: STATUS_LABELS[b.status] || b.status,
          customer_name: b.customers?.full_name || "—",
          customer_phone: b.customers?.phone || "—",
          customer_email: b.customers?.email || "—",
          pickup_date: b.pickup_date, pickup_time: b.pickup_time,
          return_date: b.return_date, return_time: b.return_time,
          amount_paid: b.amount_paid, total_price: b.total_price,
          payment_status: b.payment_status, notes: b.notes, created_at: b.created_at,
        })),
      };
    }

    case "get_booking": {
      if (!args.booking_ref && !args.id) return { error: "Provide booking_ref or id." };
      let q = sb.from("bookings").select("*,customers(full_name,phone,email,driver_license,risk_flag,flagged,banned,no_show_count,notes)");
      if (args.booking_ref) q = q.eq("booking_ref", args.booking_ref); else q = q.eq("id", args.id);
      const { data, error } = await q.single();
      if (error) return { error: error.message };
      return { booking: { ...data, vehicle_name: VEHICLE_NAMES[data.vehicle_id] || data.vehicle_id, status_label: STATUS_LABELS[data.status] || data.status } };
    }

    case "update_booking": {
      if (!args.booking_ref && !args.id) return { error: "Provide booking_ref or id." };
      const validStatuses = ["pending","approved","active","completed","cancelled"];
      if (args.status && !validStatuses.includes(args.status)) return { error: `status must be one of: ${validStatuses.join(", ")}` };
      if (args.return_date && !isValidDate(args.return_date)) return { error: "return_date must be a valid YYYY-MM-DD date." };
      if (typeof args.amount_paid === "number" && args.amount_paid < 0) return { error: "amount_paid cannot be negative." };
      if (typeof args.total_price === "number" && args.total_price < 0) return { error: "total_price cannot be negative." };
      const updates = { updated_at: new Date().toISOString() };
      if (args.status)                             updates.status         = args.status;
      if (args.notes !== undefined)                updates.notes          = String(args.notes).slice(0, 1000);
      if (args.cancel_reason)                      updates.cancel_reason  = String(args.cancel_reason).slice(0, 500);
      if (typeof args.amount_paid === "number")    updates.amount_paid    = args.amount_paid;
      if (typeof args.total_price === "number")    updates.total_price    = args.total_price;
      if (args.return_date)                        updates.return_date    = args.return_date;
      if (args.return_time)                        updates.return_time    = args.return_time;
      if (args.payment_method)                     updates.payment_method = args.payment_method;
      let q = sb.from("bookings").update(updates);
      if (args.booking_ref) q = q.eq("booking_ref", args.booking_ref); else q = q.eq("id", args.id);
      const { data, error } = await q.select().single();
      if (error) return { error: error.message };
      if (args.status && data?.vehicle_id) {
        const rsMap = { pending:"available", approved:"reserved", active:"rented", completed:"available", cancelled:"available" };
        const rs = rsMap[args.status];
        if (rs) await sb.from("vehicles").update({ rental_status: rs, updated_at: new Date().toISOString() }).eq("vehicle_id", data.vehicle_id);
      }
      return { success: true, booking: { ...data, vehicle_name: VEHICLE_NAMES[data.vehicle_id], status_label: STATUS_LABELS[data.status] } };
    }

    case "create_booking": {
      if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
      if (!args.customer_name) return { error: "customer_name is required." };
      if (!args.pickup_date || !args.return_date) return { error: "pickup_date and return_date are required." };
      if (!isValidDate(args.pickup_date)) return { error: "pickup_date must be a valid YYYY-MM-DD date." };
      if (!isValidDate(args.return_date)) return { error: "return_date must be a valid YYYY-MM-DD date." };
      if (args.pickup_date > args.return_date) return { error: "pickup_date must be on or before return_date." };
      if (typeof args.amount_paid === "number" && args.amount_paid < 0) return { error: "amount_paid cannot be negative." };
      let customerId = null;
      if (args.phone || args.email) {
        const phone = args.phone ? String(args.phone).replace(/\D/g, "") : null;
        let cq = sb.from("customers").select("id");
        if (phone) cq = cq.eq("phone", phone); else cq = cq.eq("email", args.email);
        const { data: existing } = await cq.maybeSingle();
        if (existing) {
          customerId = existing.id;
        } else {
          const { data: nc } = await sb.from("customers")
            .insert({ full_name: args.customer_name, phone: phone || null, email: args.email || null, created_at: new Date().toISOString() })
            .select("id").single();
          customerId = nc?.id || null;
        }
      }
      const bookingRef = "SLY-" + crypto.randomBytes(3).toString("hex").toUpperCase();
      const booking = {
        booking_ref:    bookingRef,
        vehicle_id:     args.vehicle_id,
        customer_id:    customerId,
        status:         "approved",
        pickup_date:    args.pickup_date,
        pickup_time:    args.pickup_time || null,
        return_date:    args.return_date,
        return_time:    args.return_time || null,
        amount_paid:    args.amount_paid || 0,
        total_price:    args.amount_paid || 0,
        payment_method: "cash",
        payment_status: args.amount_paid ? "paid" : "unpaid",
        notes:          args.notes ? String(args.notes).slice(0, 1000) : "Manual booking",
        created_at:     new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      };
      const { data, error } = await sb.from("bookings").insert(booking).select().single();
      if (error) return { error: error.message };
      await sb.from("blocked_dates").insert({ vehicle_id: args.vehicle_id, from_date: args.pickup_date, to_date: args.return_date, reason: "Manual booking " + bookingRef, created_at: new Date().toISOString() });
      return { success: true, booking: { ...data, vehicle_name: VEHICLE_NAMES[data.vehicle_id] } };
    }

    // ── Customers ─────────────────────────────────────────────────────────────

    case "query_customers": {
      let q = sb.from("customers")
        .select("id,full_name,phone,email,driver_license,risk_flag,flagged,banned,flag_reason,ban_reason,no_show_count,notes,created_at")
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(args.limit) || 20, 50));
      if (typeof args.flagged === "boolean") q = q.eq("flagged", args.flagged);
      if (typeof args.banned  === "boolean") q = q.eq("banned",  args.banned);
      if (args.risk_flag) q = q.eq("risk_flag", args.risk_flag);
      if (args.search) {
        const s = args.search.trim().replace(/'/g, "''");
        q = q.or(`full_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
      }
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { count: (data || []).length, customers: data || [] };
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
      if (updates.risk_flag && !["low","medium","high"].includes(updates.risk_flag)) {
        return { error: "risk_flag must be low, medium, or high." };
      }
      const { data, error } = await sb.from("customers").update(updates).eq("id", args.id).select().single();
      if (error) return { error: error.message };
      return { success: true, customer: data };
    }

    // ── Vehicles & fleet ──────────────────────────────────────────────────────

    case "query_vehicles": {
      const { data, error } = await sb.from("vehicles").select("vehicle_id,data,rental_status,updated_at").order("vehicle_id");
      if (error) return { error: error.message };
      return {
        vehicles: (data || []).map(v => ({
          vehicle_id:    v.vehicle_id,
          display_name:  VEHICLE_NAMES[v.vehicle_id] || v.vehicle_id,
          rental_status: v.rental_status,
          available:     v.rental_status === "available",
          updated_at:    v.updated_at,
          ...(v.data || {}),
        })),
      };
    }

    case "get_fleet_status": {
      const { data, error } = await sb.from("vehicles").select("vehicle_id,rental_status,updated_at").order("vehicle_id");
      if (error) return { error: error.message };
      return {
        fleet: (data || []).map(v => ({
          vehicle_id:    v.vehicle_id,
          name:          VEHICLE_NAMES[v.vehicle_id] || v.vehicle_id,
          rental_status: v.rental_status,
          available:     v.rental_status === "available",
          updated_at:    v.updated_at,
        })),
      };
    }

    case "set_vehicle_availability": {
      if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
      if (typeof args.available !== "boolean") return { error: "available must be true or false." };
      const rental_status = args.available ? "available" : "maintenance";
      const { error } = await sb.from("vehicles").update({ rental_status, updated_at: new Date().toISOString() }).eq("vehicle_id", args.vehicle_id);
      if (error) return { error: error.message };
      return { success: true, vehicle_id: args.vehicle_id, vehicle_name: VEHICLE_NAMES[args.vehicle_id], available: args.available, rental_status };
    }

    case "update_vehicle": {
      if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
      const ALLOWED_V = ["purchase_price","purchase_date","status","vehicle_name","vehicle_year","cover_image"];
      const safe = {};
      for (const f of ALLOWED_V) {
        if (args[f] === undefined) continue;
        if (f === "status" && !["active","inactive","sold"].includes(args[f])) return { error: "status must be active, inactive, or sold." };
        if (f === "purchase_price" && (isNaN(Number(args[f])) || Number(args[f]) < 0)) return { error: "purchase_price must be a non-negative number." };
        if (f === "purchase_date" && !isValidDate(args[f])) return { error: "purchase_date must be a valid YYYY-MM-DD date." };
        safe[f] = args[f];
      }
      if (!Object.keys(safe).length) return { error: "No valid fields to update." };
      const { data: existing } = await sb.from("vehicles").select("data").eq("vehicle_id", args.vehicle_id).maybeSingle();
      const merged = { ...(existing?.data || {}), ...safe };
      const { error } = await sb.from("vehicles").update({ data: merged, updated_at: new Date().toISOString() }).eq("vehicle_id", args.vehicle_id);
      if (error) return { error: error.message };
      return { success: true, vehicle_id: args.vehicle_id, updated: safe };
    }

    // ── Calendar & availability ───────────────────────────────────────────────

    case "get_blocked_dates": {
      let q = sb.from("blocked_dates").select("id,vehicle_id,from_date,to_date,reason,created_at").order("from_date");
      if (args.vehicle_id && ALLOWED_VEHICLES.includes(args.vehicle_id)) q = q.eq("vehicle_id", args.vehicle_id);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { count: (data || []).length, blocked_dates: (data || []).map(r => ({ ...r, vehicle_name: VEHICLE_NAMES[r.vehicle_id] || r.vehicle_id })) };
    }

    case "block_dates": {
      if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
      if (!args.from || !args.to) return { error: "from and to are required." };
      if (!isValidDate(args.from)) return { error: "from must be a valid YYYY-MM-DD date." };
      if (!isValidDate(args.to))   return { error: "to must be a valid YYYY-MM-DD date." };
      if (args.from > args.to)     return { error: "from must be on or before to." };
      const record = { vehicle_id: args.vehicle_id, from_date: args.from, to_date: args.to, reason: args.reason ? String(args.reason).slice(0, 200) : null, created_at: new Date().toISOString() };
      const { data, error } = await sb.from("blocked_dates").insert(record).select().single();
      if (error) return { error: error.message };
      return { success: true, blocked: { ...data, vehicle_name: VEHICLE_NAMES[data.vehicle_id] } };
    }

    case "unblock_dates": {
      if (!ALLOWED_VEHICLES.includes(args.vehicle_id)) return { error: `Unknown vehicle_id: ${args.vehicle_id}` };
      if (!args.from || !args.to) return { error: "from and to are required." };
      const { data, error } = await sb.from("blocked_dates").delete().eq("vehicle_id", args.vehicle_id).eq("from_date", args.from).eq("to_date", args.to).select();
      if (error) return { error: error.message };
      return { success: true, removed: (data || []).length, vehicle_name: VEHICLE_NAMES[args.vehicle_id] };
    }

    // ── Site & system settings ────────────────────────────────────────────────

    case "get_site_settings": {
      const { data, error } = await sb.from("site_settings").select("key,value").order("key");
      if (error) return { error: error.message };
      const settings = {};
      for (const row of (data || [])) settings[row.key] = row.value;
      return { settings };
    }

    case "update_site_settings": {
      const raw = args.settings || {};
      const safe = {};
      for (const [k, v] of Object.entries(raw)) {
        if (ALLOWED_SETTINGS_KEYS.has(k)) safe[k] = v === null ? null : String(v).slice(0, MAX_SETTING_VALUE_LENGTH);
      }
      if (!Object.keys(safe).length) return { error: "No valid settings keys provided." };
      const rows = Object.entries(safe).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
      const { error } = await sb.from("site_settings").upsert(rows, { onConflict: "key" });
      if (error) return { error: error.message };
      return { success: true, updated: safe };
    }

    case "get_system_settings": {
      const { data, error } = await sb.from("system_settings").select("category,key,value,updated_at").order("category").order("key");
      if (error) return { error: error.message };
      const grouped = {};
      for (const r of (data || [])) { if (!grouped[r.category]) grouped[r.category] = {}; grouped[r.category][r.key] = r.value; }
      return { system_settings: grouped };
    }

    case "update_system_setting": {
      const { category, key, value } = args;
      if (!category || !key || value === undefined) return { error: "category, key, and value are required." };
      if (!ALLOWED_SYSTEM_SETTING_CATEGORIES.includes(category)) return { error: `category must be one of: ${ALLOWED_SYSTEM_SETTING_CATEGORIES.join(", ")}.` };
      const { error } = await sb.from("system_settings").upsert({ category, key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: "category,key" });
      if (error) return { error: error.message };
      return { success: true, category, key, value: String(value) };
    }

    // ── SMS templates ─────────────────────────────────────────────────────────

    case "get_sms_templates": {
      const { data, error } = await sb.from("sms_template_overrides").select("template_key,message,enabled,updated_at").order("template_key");
      if (error) return { error: error.message };
      return { templates: data || [] };
    }

    case "update_sms_template": {
      const { template_key, message, enabled } = args;
      if (!template_key) return { error: "template_key is required." };
      const record = { template_key, updated_at: new Date().toISOString() };
      if (typeof message === "string")  record.message = message.slice(0, 1000);
      if (typeof enabled === "boolean") record.enabled = enabled;
      if (!record.message && record.enabled === undefined) return { error: "Provide message or enabled." };
      const { data, error } = await sb.from("sms_template_overrides").upsert(record, { onConflict: "template_key" }).select().single();
      if (error) return { error: error.message };
      return { success: true, template: data };
    }

    // ── Content blocks ────────────────────────────────────────────────────────

    case "get_content_blocks": {
      let q = sb.from("content_blocks").select("block_id,type,title,body,active,sort_order,author_name,author_location,expires_at,created_at,updated_at").order("sort_order");
      if (args.type) q = q.eq("type", args.type);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { count: (data || []).length, blocks: data || [] };
    }

    case "manage_content_block": {
      const BT = ["faq","announcement","testimonial"];
      const BF = new Set(["type","title","body","author_name","author_location","sort_order","active","expires_at"]);
      const { action } = args;
      if (action === "create") {
        if (!BT.includes(args.type)) return { error: `type must be one of: ${BT.join(", ")}` };
        if (!args.title) return { error: "title is required." };
        const block = { block_id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        for (const f of BF) { if (args[f] !== undefined) block[f] = args[f]; }
        if (block.active === undefined) block.active = true;
        if (block.sort_order === undefined) block.sort_order = 0;
        const { data, error } = await sb.from("content_blocks").insert(block).select().single();
        if (error) return { error: error.message };
        return { success: true, block: data };
      }
      if (action === "update") {
        if (!args.block_id) return { error: "block_id is required for update." };
        const updates = { updated_at: new Date().toISOString() };
        for (const f of BF) { if (args[f] !== undefined) updates[f] = args[f]; }
        const { data, error } = await sb.from("content_blocks").update(updates).eq("block_id", args.block_id).select().single();
        if (error) return { error: error.message };
        return { success: true, block: data };
      }
      if (action === "delete") {
        if (!args.block_id) return { error: "block_id is required for delete." };
        const { error } = await sb.from("content_blocks").delete().eq("block_id", args.block_id);
        if (error) return { error: error.message };
        return { success: true, deleted_block_id: args.block_id };
      }
      return { error: `Unknown action: ${action}. Must be create, update, or delete.` };
    }

    // ── Protection plans ──────────────────────────────────────────────────────

    case "query_protection_plans": {
      const { data, error } = await sb.from("protection_plans").select("*").order("sort_order").order("name");
      if (error) return { error: error.message };
      return { plans: data || [] };
    }

    case "manage_protection_plan": {
      const { action } = args;
      if (action === "create") {
        if (!args.name) return { error: "name is required." };
        if (typeof args.daily_rate === "number" && args.daily_rate < 0) return { error: "daily_rate cannot be negative." };
        const plan = {
          name:          args.name,
          description:   args.description || null,
          daily_rate:    Number(args.daily_rate || 0),
          liability_cap: Number(args.liability_cap || 0),
          is_active:     args.is_active ?? true,
          sort_order:    Number(args.sort_order || 0),
          created_at:    new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        };
        const { data, error } = await sb.from("protection_plans").insert(plan).select().single();
        if (error) return { error: error.message };
        return { success: true, plan: data };
      }
      if (action === "update") {
        if (!args.id) return { error: "id is required for update." };
        if (typeof args.daily_rate === "number" && args.daily_rate < 0) return { error: "daily_rate cannot be negative." };
        const updates = { updated_at: new Date().toISOString() };
        for (const f of ["name","description","daily_rate","liability_cap","is_active","sort_order"]) {
          if (args[f] !== undefined) updates[f] = args[f];
        }
        const { data, error } = await sb.from("protection_plans").update(updates).eq("id", args.id).select().single();
        if (error) return { error: error.message };
        return { success: true, plan: data };
      }
      if (action === "delete") {
        if (!args.id) return { error: "id is required for delete." };
        const { error } = await sb.from("protection_plans").delete().eq("id", args.id);
        if (error) return { error: error.message };
        return { success: true, deleted_id: args.id };
      }
      return { error: `Unknown action: ${action}. Must be create, update, or delete.` };
    }

    // ── Waitlist ──────────────────────────────────────────────────────────────

    case "query_waitlist": {
      const data = await ghReadJson("waitlist.json", {});
      const entries = [];
      for (const [vehicleId, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (args.vehicle_id && vehicleId !== args.vehicle_id) continue;
          if (args.status && entry.status !== args.status) continue;
          entries.push({ ...entry, vehicle_id: vehicleId, vehicle_name: VEHICLE_NAMES[vehicleId] || vehicleId });
        }
      }
      entries.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      return { count: entries.length, waitlist: entries };
    }

    // ── Analytics & dashboard ─────────────────────────────────────────────────

    case "get_analytics": {
      const fromDate = periodToFromDate(args.period || "month");
      let bq = sb.from("bookings").select("id,vehicle_id,status,pickup_date,return_date,amount_paid,total_price");
      if (fromDate) bq = bq.gte("pickup_date", fromDate);
      const [bRes, rRes, eRes] = await Promise.all([
        bq,
        sb.from("revenue_records").select("vehicle_id,gross_amount,net,is_no_show,is_cancelled").gte("rental_date", fromDate || "2000-01-01"),
        sb.from("expenses").select("vehicle_id,amount").gte("date", fromDate || "2000-01-01"),
      ]);
      const bookings = bRes.data || []; const revenue = rRes.data || []; const expenses = eRes.data || [];
      const vMap = {};
      for (const vid of ALLOWED_VEHICLES) vMap[vid] = { name: VEHICLE_NAMES[vid], bookings: 0, active: 0, completed: 0, revenue: 0, expenses: 0 };
      const statusCounts = {};
      for (const b of bookings) {
        statusCounts[b.status] = (statusCounts[b.status] || 0) + 1;
        if (vMap[b.vehicle_id]) { vMap[b.vehicle_id].bookings++; if (b.status === "active") vMap[b.vehicle_id].active++; if (b.status === "completed") vMap[b.vehicle_id].completed++; }
      }
      for (const r of revenue)  { if (vMap[r.vehicle_id] && !r.is_no_show && !r.is_cancelled) vMap[r.vehicle_id].revenue  += Number(r.gross_amount || 0); }
      for (const e of expenses) { if (vMap[e.vehicle_id]) vMap[e.vehicle_id].expenses += Number(e.amount || 0); }
      const totalRevenue  = revenue.filter(r => !r.is_no_show && !r.is_cancelled).reduce((s, r) => s + Number(r.gross_amount || 0), 0);
      const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
      return {
        period: args.period || "month", from_date: fromDate || "all time",
        total_bookings: bookings.length, status_breakdown: statusCounts,
        total_revenue: r2(totalRevenue), total_expenses: r2(totalExpenses), net_profit: r2(totalRevenue - totalExpenses),
        by_vehicle: Object.values(vMap).map(v => ({ ...v, revenue: r2(v.revenue), expenses: r2(v.expenses), profit: r2(v.revenue - v.expenses) })),
      };
    }

    case "get_dashboard": {
      const today = new Date().toISOString().split("T")[0];
      const [pendingRes, pickupsRes, returnsRes, overdueRes] = await Promise.all([
        sb.from("bookings").select("id,booking_ref,vehicle_id,customers(full_name,phone)").eq("status","pending").order("created_at",{ascending:false}).limit(20),
        sb.from("bookings").select("id,booking_ref,vehicle_id,pickup_time,customers(full_name,phone)").eq("status","approved").eq("pickup_date",today).limit(20),
        sb.from("bookings").select("id,booking_ref,vehicle_id,return_time,customers(full_name,phone)").eq("status","active").eq("return_date",today).limit(20),
        sb.from("bookings").select("id,booking_ref,vehicle_id,return_date,customers(full_name,phone)").eq("status","active").lt("return_date",today).limit(20),
      ]);
      const fmt = rows => (rows || []).map(b => ({ booking_ref: b.booking_ref, vehicle: VEHICLE_NAMES[b.vehicle_id] || b.vehicle_id, customer: b.customers?.full_name || "—", phone: b.customers?.phone || "—", pickup_time: b.pickup_time, return_time: b.return_time, return_date: b.return_date }));
      return {
        today,
        pending_approvals: { count: (pendingRes.data||[]).length, items: fmt(pendingRes.data) },
        pickups_today:     { count: (pickupsRes.data||[]).length, items: fmt(pickupsRes.data) },
        returns_today:     { count: (returnsRes.data||[]).length, items: fmt(returnsRes.data) },
        overdue:           { count: (overdueRes.data||[]).length, items: fmt(overdueRes.data) },
      };
    }

    default:
      return { error: `Unknown action: ${name}` };
  }
}
