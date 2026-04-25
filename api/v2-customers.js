// api/v2-customers.js
// SLYTRANS Fleet Control v2 — Customer management endpoint.
// Customers are derived from booking history and stored additively in Supabase.
// Falls back to GitHub (customers.json) when Supabase is unavailable or tables missing.
//
// POST /api/v2-customers
// Actions:
//   list    — { secret, action:"list", banned?, flagged?, search? }
//   get     — { secret, action:"get", id }
//   upsert  — { secret, action:"upsert", name, email?, phone?, ...fields } (email-first; phone fallback)
//   update  — { secret, action:"update", id, updates:{flagged?, banned?, flag_reason?, ban_reason?, notes?} }
//   sync    — { secret, action:"sync" } — build/refresh customer table from bookings.json
//
// Error contract:
//   • READ actions (list, get) return empty state when Supabase is not configured
//     or the table does not yet exist, so the admin panel never crashes.
//   • WRITE actions (upsert, update, sync) fall back to GitHub when Supabase is
//     unavailable or the customers table is missing.

import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { loadBookings, normalizePhone } from "./_bookings.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { loadExpenses } from "./_expenses.js";

/**
 * Compute the number of rental days between two date strings.
 * Defaults to 1 if dates are missing or the result is <= 0.
 */
function computeRentalDays(pickup, returnDate) {
  if (!pickup || !returnDate) return 1;
  const diff = Math.ceil((new Date(returnDate) - new Date(pickup)) / 86400000);
  return diff > 0 ? diff : 1;
}

/**
 * Derive a customer tier from financial and risk data.
 * Returns one of: 'vip' | 'standard' | 'risky' | 'unprofitable'
 */
function computeCustomerTier({ totalProfit, totalBookings, riskFlag, flagged, banned, noShowCount }) {
  if (banned)                                    return "risky";
  if (totalProfit < 0)                           return "unprofitable";
  if (flagged || riskFlag === "high" || (noShowCount || 0) >= 2) return "risky";
  if (totalProfit >= 500 && totalBookings >= 3)  return "vip";
  if (totalBookings >= 1 && totalProfit >= 0)    return "standard";
  return "standard";
}

function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized || null;
}

function normalizeCustomerName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function customerIdentityKey(c) {
  const phone = c?.phone ? normalizePhone(String(c.phone).trim()) : null;
  if (phone) return `phone:${phone}`;
  const email = normalizeEmail(c?.email);
  if (email) return `email:${email}`;
  const name = c?.name ? String(c.name).trim().toLowerCase() : null;
  if (name) return `name:${name}`;
  if (c?.id) return `id:${c.id}`;
  return `unknown:${String(c?.phone || "")}|${String(c?.email || "").toLowerCase()}|${String(c?.name || "").toLowerCase()}|${String(c?.created_at || "")}|${String(c?.updated_at || "")}`;
}

function customerSortTimestamp(c) {
  const updated = Date.parse(c?.updated_at || "");
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(c?.created_at || "");
  if (Number.isFinite(created)) return created;
  return 0;
}

function pickCanonicalCustomer(a, b) {
  const ta = customerSortTimestamp(a);
  const tb = customerSortTimestamp(b);
  if (tb > ta) return b;
  if (ta > tb) return a;
  const aScore = (a?.phone ? 4 : 0) + (a?.email ? 2 : 0) + (a?.name ? 1 : 0);
  const bScore = (b?.phone ? 4 : 0) + (b?.email ? 2 : 0) + (b?.name ? 1 : 0);
  return bScore > aScore ? b : a;
}

function dedupeCustomersForList(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const byKey = new Map();
  for (const row of rows) {
    const key = customerIdentityKey(row);
    const existing = byKey.get(key);
    byKey.set(key, existing ? pickCanonicalCustomer(existing, row) : row);
  }
  return [...byKey.values()];
}

// TODO(customer-email-dedup): Remove legacy multi-row scan and return to limit(1)
// after migration 0058 has been applied in production and duplicate email rows are gone.
// This is intentionally high enough to cover legacy duplicate clusters while still bounded.
const MAX_LEGACY_EMAIL_MATCH_ROWS = 250;

function escapeLikePattern(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

async function findMostRecentCustomerByEmail(sb, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { existing: null, error: null };
  // Match by LOWER(email) semantics so legacy mixed-case rows are still found.
  // PostgREST filters cannot directly target LOWER(btrim(email)) here, so we query
  // case-insensitively and keep only exact normalized matches in-process.
  // Prefer the latest non-null timestamps so we update the canonical current row
  // when legacy duplicate email rows exist.
  // Limit is intentionally >1 while legacy duplicate rows are being cleaned up.
  const { data, error } = await sb.from("customers")
    .select("id, email, updated_at, created_at")
    .ilike("email", escapeLikePattern(normalizedEmail))
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(MAX_LEGACY_EMAIL_MATCH_ROWS);
  if (error) return { existing: null, error };
  const exact = (Array.isArray(data) ? data : []).filter((row) => normalizeEmail(row?.email) === normalizedEmail);
  const existing = exact.length > 0 ? exact[0] : null;
  return { existing, error: null };
}

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const GITHUB_REPO     = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const CUSTOMERS_FILE  = "customers.json";

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
}

// ── GitHub fallback helpers ───────────────────────────────────────────────────

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function loadCustomersFromGitHub() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CUSTOMERS_FILE}`;
  const resp   = await fetch(apiUrl, { headers: ghHeaders() });
  if (!resp.ok) {
    if (resp.status === 404) return { data: [], sha: null };
    return { data: [], sha: null };
  }
  const file = await resp.json();
  let data = [];
  try {
    const parsed = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (Array.isArray(parsed)) data = parsed;
  } catch { data = []; }
  return { data, sha: file.sha };
}

async function saveCustomersToGitHub(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("v2-customers: GITHUB_TOKEN not set — customers.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CUSTOMERS_FILE}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT customers.json failed: ${resp.status} ${text}`);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET)
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });

  const body = req.body || {};
  const { secret, action } = body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const sb = getSupabase();

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      if (sb) {
        try {
          let q = sb.from("customers").select("*").order("last_booking_date", { ascending: false, nullsFirst: false });
          if (body.banned  === true  || body.banned  === "true")  q = q.eq("banned",  true);
          if (body.flagged === true  || body.flagged === "true")   q = q.eq("flagged", true);
          if (body.search) {
            q = q.or(`name.ilike.%${body.search}%,phone.ilike.%${body.search}%,email.ilike.%${body.search}%`);
          }
          const { data, error } = await q;
          if (!error) return res.status(200).json({ customers: dedupeCustomersForList(data || []) });
          console.error("v2-customers list error:", error.message);
        } catch (qErr) {
          console.error("v2-customers list query error:", qErr);
        }
      }
      // GitHub fallback
      const { data: ghCustomers } = await loadCustomersFromGitHub();
      let customers = ghCustomers;
      if (body.banned  === true  || body.banned  === "true")  customers = customers.filter((c) => c.banned);
      if (body.flagged === true  || body.flagged === "true")  customers = customers.filter((c) => c.flagged);
      if (body.search) {
        const s = String(body.search).toLowerCase();
        customers = customers.filter((c) =>
          (c.name  || "").toLowerCase().includes(s) ||
          (c.phone || "").toLowerCase().includes(s) ||
          (c.email || "").toLowerCase().includes(s)
        );
      }
      return res.status(200).json({ customers });
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { data, error } = await sb.from("customers").select("*").eq("id", body.id).single();
        if (!error) return res.status(200).json({ customer: data });
        if (!isSchemaError(error)) throw error;
      }
      // GitHub fallback
      const { data: ghCustomers } = await loadCustomersFromGitHub();
      const found = ghCustomers.find((c) => c.id === body.id);
      if (!found) return res.status(404).json({ error: "Customer not found" });
      return res.status(200).json({ customer: found });
    }

    // ── UPSERT ──────────────────────────────────────────────────────────────
    if (action === "upsert") {
      const { name, phone, email } = body;
      if (!name) return res.status(400).json({ error: "name is required" });
      if ((!phone || !String(phone).trim()) && !normalizeEmail(email)) {
        return res.status(400).json({ error: "email or phone is required for upsert" });
      }

      const record = {
        name: normalizeCustomerName(String(name)) || "Unknown",
        phone: phone ? normalizePhone(String(phone).trim()) : null,
        email: normalizeEmail(email),
        notes:      body.notes || null,
        updated_at: new Date().toISOString(),
      };

      if (sb) {
        try {
          if (record.email) {
            const { existing, error: existingErr } = await findMostRecentCustomerByEmail(sb, record.email);
            if (existingErr) throw existingErr;
            if (existing) {
              const { error: updateErr } = await sb.from("customers")
                .update(record)
                .eq("id", existing.id);
              if (!updateErr) {
                const { data: fresh } = await sb.from("customers").select("*").eq("id", existing.id).maybeSingle();
                return res.status(200).json({ customer: fresh || { ...record, id: existing.id } });
              }
              if (!isSchemaError(updateErr)) throw updateErr;
            } else {
              const { error: insertErr } = await sb.from("customers").insert(record);
              if (!insertErr) {
                const { existing: fresh } = await findMostRecentCustomerByEmail(sb, record.email);
                return res.status(200).json({ customer: fresh ? { ...record, id: fresh.id } : record });
              }
              if (!isSchemaError(insertErr)) throw insertErr;
            }
          } else {
            const { error: upsertErr } = await sb.from("customers")
              .upsert(record, { onConflict: "phone", ignoreDuplicates: false });
            if (upsertErr) {
              if (!isSchemaError(upsertErr)) throw upsertErr;
              console.warn("v2-customers upsert: customers table missing, falling back to GitHub");
            } else {
              const { data, error: fetchErr } = await sb.from("customers")
                .select("*").eq("phone", record.phone).single();
              if (!fetchErr) return res.status(200).json({ customer: data });
              if (!isSchemaError(fetchErr)) throw fetchErr;
            }
          }
        } catch (sbErr) {
          if (!isSchemaError(sbErr)) throw sbErr;
          console.warn("v2-customers upsert: customers table missing, falling back to GitHub");
        }
      }
      // GitHub fallback
      let upserted;
      await updateJsonFileWithRetry({
        load:    loadCustomersFromGitHub,
        apply:   (data) => {
          const idx = record.email
            ? data.findIndex((c) => normalizeEmail(c.email) === record.email)
            : data.findIndex((c) => c.phone === record.phone);
          if (idx !== -1) {
            Object.assign(data[idx], record);
            upserted = data[idx];
          } else {
            const newCustomer = { id: randomUUID(), ...record, created_at: new Date().toISOString() };
            data.push(newCustomer);
            upserted = newCustomer;
          }
        },
        save:    saveCustomersToGitHub,
        message: `v2: Upsert customer ${record.phone}`,
      });
      return res.status(200).json({ customer: upserted });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const allowed = ["flagged","banned","flag_reason","ban_reason","notes","name","full_name","phone","email","driver_license","risk_flag"];
      const updates = { updated_at: new Date().toISOString() };
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      if (Object.prototype.hasOwnProperty.call(updates, "email")) {
        updates.email = normalizeEmail(updates.email);
      }
      if (Object.prototype.hasOwnProperty.call(updates, "name")) {
        updates.name = normalizeCustomerName(updates.name) || "Unknown";
      }
      if (Object.prototype.hasOwnProperty.call(updates, "full_name")) {
        updates.full_name = normalizeCustomerName(updates.full_name) || updates.full_name;
      }
      if (updates.risk_flag !== undefined && updates.risk_flag !== null &&
          !["low","medium","high"].includes(updates.risk_flag)) {
        return res.status(400).json({ error: "risk_flag must be low, medium, or high" });
      }

      if (sb) {
        const { data, error } = await sb.from("customers").update(updates).eq("id", body.id).select().single();
        if (!error) return res.status(200).json({ customer: data });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-customers update: customers table missing, falling back to GitHub");
      }
      // GitHub fallback
      let updated;
      await updateJsonFileWithRetry({
        load:    loadCustomersFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((c) => c.id === body.id);
          if (idx === -1) throw new Error("Customer not found");
          Object.assign(data[idx], updates);
          updated = data[idx];
        },
        save:    saveCustomersToGitHub,
        message: `v2: Update customer ${body.id}`,
      });
      return res.status(200).json({ customer: updated });
    }

    // ── SYNC — rebuild customer table from revenue_records (Supabase) or bookings.json ───────────────────
    if (action === "sync") {
      // When Supabase is available, compute accurate customer stats directly from
      // revenue_records (the authoritative financial ledger) rather than bookings.json.
      // This prevents the double-counting bug where incremental autoUpsertCustomer
      // calls accumulate incorrect totals over time.
      if (sb) {
        try {
          // Query revenue_records_effective directly with payment_status='paid' —
          // the same source used by v2-dashboard.js and the Revenue Tracker page.
          // This ensures stored customer totals include every paid record (including
          // rows marked is_orphan) so that Customer Management matches Revenue Tracker.
          const rrResult = await sb
            .from("revenue_records_effective")
            .select([
              "booking_id", "customer_phone", "customer_name", "customer_email",
              "gross_amount", "stripe_fee", "stripe_net", "refund_amount", "net_amount",
              "is_cancelled", "is_no_show", "pickup_date", "return_date", "vehicle_id",
            ].join(", "))
            .eq("payment_status", "paid");

          const { data: rrData, error: rrError } = rrResult;
          // revenue_records_effective already excludes sync_excluded rows via its WHERE clause.
          const rrRows = rrData || [];

          if (!rrError && Array.isArray(rrRows) && rrRows.length > 0) {
              // Group revenue records by the best available identity key, in priority order:
              //   1. Normalized email (primary identity key)
              //   2. Normalized phone (fallback only when email is missing)
              //   3. Normalized name (last-resort fallback)
              // This ensures no revenue row is silently dropped.
              const byKey = {};
              for (const r of rrRows) {
                const normPhone = r.customer_phone ? normalizePhone(r.customer_phone) : null;
                const normEmail = normalizeEmail(r.customer_email);
                const normName  = r.customer_name  ? r.customer_name.toLowerCase().trim()  : null;

                let key;
                let keyType;
                if (normEmail) {
                  key = `email:${normEmail}`;
                  keyType = "email";
                } else if (normPhone) {
                  key = normPhone;
                  keyType = "phone";
                } else if (normName) {
                  key = `name:${normName}`;
                  keyType = "name";
              } else {
                continue; // no identity at all — truly unattributable
              }

              if (!byKey[key]) {
                byKey[key] = {
                  keyType,
                  phone: normPhone,
                  email: normEmail,
                  name:  normalizeCustomerName(r.customer_name) || "Unknown",
                  records: [],
                };
              }
              // Prefer the most complete values seen across all records for this key:
              // use first-non-null-wins for all three fields, except we upgrade the
              // "Unknown" placeholder name if a real name appears later.
              if (normPhone && !byKey[key].phone) byKey[key].phone = normPhone;
              if (normEmail && !byKey[key].email) byKey[key].email = normEmail;
              if (r.customer_name && (!byKey[key].name || byKey[key].name === "Unknown"))
                byKey[key].name = normalizeCustomerName(r.customer_name) || byKey[key].name;
              byKey[key].records.push(r);
            }

            // Pre-compute total rental days per vehicle across ALL records (for expense attribution).
            const vehicleTotalDays = {};
            for (const r of rrRows) {
              if (!r.vehicle_id || r.is_cancelled || r.is_no_show) continue;
              vehicleTotalDays[r.vehicle_id] = (vehicleTotalDays[r.vehicle_id] || 0)
                + computeRentalDays(r.pickup_date, r.return_date);
            }

            // Load vehicle expenses for profitability attribution.
            const expensesByVehicle = {};
            try {
              const { data: expData } = await loadExpenses();
              for (const exp of (expData || [])) {
                if (!exp.vehicle_id) continue;
                expensesByVehicle[exp.vehicle_id] = (expensesByVehicle[exp.vehicle_id] || 0)
                  + Number(exp.amount || 0);
              }
            } catch (expErr) {
              console.warn("v2-customers sync: could not load expenses for attribution:", expErr.message);
            }

            // ── Build per-customer financial records ──────────────────────
            // Separate into three buckets for different upsert strategies:
            //   phoneUpserts   — no email, but have a phone (phone fallback)
            //   emailFallbacks — email-keyed records (primary)
            //   nameFallbacks  — no phone, no email, looked up by name+null-phone
            const phoneUpserts   = [];
            const emailFallbacks = [];
            const nameFallbacks  = [];

            // Accumulators for the aggregation console log
            let aggGross  = 0;
            let aggFees   = 0;
            let aggStrNet = 0;
            let aggNet    = 0;
            let aggRows   = 0;

            for (const [, cust] of Object.entries(byKey)) {
              const valid       = cust.records.filter((r) => !r.is_cancelled && !r.is_no_show);
              const pickupDates = cust.records.map((r) => r.pickup_date).filter(Boolean).sort();

              // Financial totals — canonical formula matching dashboard & analytics:
              //   net per record = (stripe_net ?? gross − fee) − refund_amount
              const grossRevenue  = valid.reduce((s, r) => s + Number(r.gross_amount  || 0), 0);
              const stripeFees    = valid.reduce((s, r) => s + Number(r.stripe_fee    || 0), 0);
              const refunds       = valid.reduce((s, r) => s + Number(r.refund_amount || 0), 0);
              const netRevenue    = valid.reduce((s, r) => {
                const gross = Number(r.gross_amount || 0);
                const fee   = Number(r.stripe_fee   || 0);
                const net   = r.stripe_net != null ? Number(r.stripe_net) : gross - fee;
                return s + net - Number(r.refund_amount || 0);
              }, 0);
              const stripeNetSum  = valid.reduce((s, r) => {
                const gross = Number(r.gross_amount || 0);
                const fee   = Number(r.stripe_fee   || 0);
                return s + (r.stripe_net != null ? Number(r.stripe_net) : gross - fee);
              }, 0);
              // total_spent kept for backwards compatibility (= gross after refunds, no Stripe fee deduction)
              const totalSpent    = Math.round((grossRevenue - refunds) * 100) / 100;

              // Accumulate into aggregation totals
              aggGross  += grossRevenue;
              aggFees   += stripeFees;
              aggStrNet += stripeNetSum;
              aggNet    += netRevenue;
              aggRows   += valid.length;

              // Rental-days per vehicle for this customer (used for expense attribution)
              const custVehicleDays = {};
              for (const r of valid) {
                if (!r.vehicle_id) continue;
                custVehicleDays[r.vehicle_id] = (custVehicleDays[r.vehicle_id] || 0)
                  + computeRentalDays(r.pickup_date, r.return_date);
              }
              const totalRentalDays = Object.values(custVehicleDays).reduce((s, d) => s + d, 0);

              // Pro-rate vehicle expenses by this customer's share of each vehicle's rental days
              let associatedExpenses = 0;
              for (const [vid, custDays] of Object.entries(custVehicleDays)) {
                const totalDays     = vehicleTotalDays[vid] || custDays;
                const fraction      = custDays / totalDays;
                associatedExpenses += fraction * (expensesByVehicle[vid] || 0);
              }

              const totalProfit       = netRevenue - associatedExpenses;
              const bookingCount      = valid.length;
              const profitPerBooking  = bookingCount  > 0 ? totalProfit / bookingCount  : 0;
              const avgProfitPerDay   = totalRentalDays > 0 ? totalProfit / totalRentalDays : 0;
              const lifetimeValue     = netRevenue; // standard LTV = cumulative net revenue

              const record = {
                name:                        cust.name,
                email:                       cust.email,
                // total_bookings is patched below from the bookings table
                // after upsert — set to revenue_records count as initial value.
                total_bookings:              bookingCount,
                total_spent:                 totalSpent,
                total_gross_revenue:         Math.round(grossRevenue       * 100) / 100,
                total_stripe_fees:           Math.round(stripeFees         * 100) / 100,
                total_net_revenue:           Math.round(netRevenue         * 100) / 100,
                associated_vehicle_expenses: Math.round(associatedExpenses * 100) / 100,
                total_profit:                Math.round(totalProfit        * 100) / 100,
                profit_per_booking:          Math.round(profitPerBooking   * 100) / 100,
                avg_profit_per_day:          Math.round(avgProfitPerDay    * 100) / 100,
                lifetime_value:              Math.round(lifetimeValue      * 100) / 100,
                first_booking_date:          pickupDates[0] || null,
                last_booking_date:           pickupDates[pickupDates.length - 1] || null,
                updated_at:                  new Date().toISOString(),
              };

              if (cust.email) {
                emailFallbacks.push({ ...record, phone: cust.phone || null, _emailKey: cust.email });
              } else if (cust.phone) {
                phoneUpserts.push({ ...record, phone: cust.phone });
              } else {
                nameFallbacks.push({ ...record, phone: null });
              }
            }

            // Print aggregation summary so it can be verified against Revenue/Dashboard totals
            console.log(
              `v2-customers sync aggregation: row_count=${aggRows}` +
              ` gross_total=${Math.round(aggGross * 100) / 100}` +
              ` stripe_fee_total=${Math.round(aggFees * 100) / 100}` +
              ` stripe_net_total=${Math.round(aggStrNet * 100) / 100}` +
              ` net_total=${Math.round(aggNet * 100) / 100}`,
            );

            const totalCustomers = phoneUpserts.length + emailFallbacks.length + nameFallbacks.length;
            if (totalCustomers > 0) {
              let schemaError = false;

              // ── 1. Phone-keyed records via bulk upsert ────────────────────
              if (phoneUpserts.length > 0) {
                const { error: upsertErr } = await sb.from("customers")
                  .upsert(phoneUpserts, { onConflict: "phone", ignoreDuplicates: false });
                if (upsertErr) {
                  if (!isSchemaError(upsertErr)) throw upsertErr;
                  console.warn("v2-customers sync: customers table missing");
                  schemaError = true;
                } else {
                  // Clean up stale duplicate records whose phone was not already
                  // in normalized form (e.g. "3463814616" now that "+13463814616"
                  // is the canonical record). Only query customers with non-normalized
                  // phones (those not already in E.164 / "+1…" format) to keep the
                  // query small.
                  const normalizedPhones = new Set(phoneUpserts.map((u) => u.phone));
                  const { data: nonNormCustomers } = await sb
                    .from("customers")
                    .select("id, phone")
                    .not("phone", "is", null)
                    .not("phone", "like", "+%");
                  if (nonNormCustomers) {
                    const staleIds = nonNormCustomers
                      .filter((c) => normalizedPhones.has(normalizePhone(c.phone)))
                      .map((c) => c.id);
                    if (staleIds.length > 0) {
                      await sb.from("customers").delete().in("id", staleIds);
                      console.log(`v2-customers sync: removed ${staleIds.length} non-normalized duplicate customer(s)`);
                    }
                  }
                }
              }

              if (!schemaError) {
                for (const record of emailFallbacks) {
                  // Strip the internal routing key before writing to the DB
                  const { _emailKey: emailKey, ...cleanRecord } = record;
                  try {
                    // Look up by email regardless of phone — a customer with phone+email
                    // already exists from the phone upsert; the .is("phone", null) filter
                    // was causing false negatives that produced duplicate rows.
                    const { existing, error: existingErr } = await findMostRecentCustomerByEmail(sb, emailKey);
                    if (existingErr) {
                      console.error("v2-customers sync email-lookup error:", existingErr.message);
                      continue;
                    }
                    if (existing) {
                      const { error } = await sb.from("customers").update(cleanRecord).eq("id", existing.id);
                      if (error) { console.error("v2-customers sync email-update error:", error.message); }
                    } else {
                      const { error } = await sb.from("customers").insert(cleanRecord);
                      if (error) { console.error("v2-customers sync email-insert error:", error.message); }
                    }
                  } catch (emailErr) {
                    console.error("v2-customers sync email-fallback error:", emailErr.message);
                  }
                }
              }

              // ── 3. Name-only records via individual lookup ────────────────
              if (!schemaError) {
                for (const record of nameFallbacks) {
                  try {
                    // Try email first (if present), then fall back to case-insensitive
                    // name matching.  Removing the phone IS NULL guard prevents misses
                    // when the customer already exists with a phone.
                    let existing = null;
                    if (record.email) {
                      const { data: existByEmail } = await sb.from("customers")
                        .select("id").eq("email", record.email).maybeSingle();
                      existing = existByEmail || null;
                    }
                    if (!existing) {
                      // Use .limit(1) rather than .maybeSingle() so we don't get an
                      // error when there happen to be multiple case-variant rows.
                      const { data: nameRows } = await sb.from("customers")
                        .select("id").ilike("name", record.name).limit(1);
                      existing = Array.isArray(nameRows) && nameRows.length > 0 ? nameRows[0] : null;
                    }
                    if (existing) {
                      const { error } = await sb.from("customers").update(record).eq("id", existing.id);
                      if (error) { console.error("v2-customers sync name-update error:", error.message); }
                    } else {
                      const { error } = await sb.from("customers").insert({ ...record, phone: null });
                      if (error) { console.error("v2-customers sync name-insert error:", error.message); }
                    }
                  } catch (nameErr) {
                    console.error("v2-customers sync name-fallback error:", nameErr.message);
                  }
                }
              }

              if (!schemaError) {
                // ── Patch total_bookings and total_spent from bookings ⨯ revenue_records ──
                // Implements the canonical aggregation:
                //   SELECT b.customer_email,
                //          COUNT(DISTINCT b.id)  AS bookings,
                //          SUM(r.net_amount)     AS total_spent
                //   FROM   bookings b
                //   LEFT JOIN revenue_records r ON r.booking_id = b.booking_ref
                //   GROUP BY b.customer_email
                //
                // Note: in revenue_records the column that stores the booking reference
                // value is named booking_id (not booking_ref), so the join is:
                //   r.booking_id = b.booking_ref
                // net_amount is the GENERATED ALWAYS column (gross_amount − refund_amount)
                // and is used directly here — no recomputation.
                // Sums across ALL revenue types (rental, extension, fee) that share
                // the same booking_id.
                try {
                  const CANCELLED_STATUSES = ["cancelled", "cancelled_rental"];
                  const { data: bkRows, error: bkErr } = await sb
                    .from("bookings")
                    .select("id, booking_ref, customer_email, customer_id")
                    .not("status", "in", `(${CANCELLED_STATUSES.join(",")})`);

                  if (!bkErr && Array.isArray(bkRows) && bkRows.length > 0) {
                    // Index net_amount per booking_id (= b.booking_ref) from rrRows.
                    // Sums across ALL revenue types (rental + extension + fee) that share
                    // the same booking_id.  Uses the pre-computed net_amount column directly.
                    const netByBookingRef = {};
                    for (const r of rrRows) {
                      // Defensive: skip cancelled/no-show even though revenue_reporting_base
                      // filters them out, because the fallback path (revenue_records_effective)
                      // does not — and rrRows is shared between both paths.
                      if (r.is_cancelled || r.is_no_show || !r.booking_id) continue;
                      // net_amount = gross_amount − refund_amount (GENERATED ALWAYS on revenue_records).
                      // Use it directly; fall back to recomputation only if the field is absent
                      // (e.g. when queried from an older view that predates migration 0072).
                      const net = r.net_amount != null
                        ? Number(r.net_amount)
                        : Number(r.gross_amount || 0) - Number(r.refund_amount || 0);
                      netByBookingRef[r.booking_id] = (netByBookingRef[r.booking_id] || 0) + net;
                    }

                    // Group bookings by customer_email and by customer_id (UUID).
                    // email is the primary key; customer_id covers phone-only bookings.
                    const byEmail      = {};
                    const byCustomerId = {};
                    for (const b of bkRows) {
                      const email  = normalizeEmail(b.customer_email);
                      const net    = netByBookingRef[b.booking_ref] ?? 0;

                      if (email) {
                        if (!byEmail[email]) byEmail[email] = { bookingCount: 0, totalSpent: 0 };
                        byEmail[email].bookingCount += 1;
                        byEmail[email].totalSpent   += net;
                      }

                      if (b.customer_id) {
                        if (!byCustomerId[b.customer_id]) byCustomerId[b.customer_id] = { bookingCount: 0, totalSpent: 0 };
                        byCustomerId[b.customer_id].bookingCount += 1;
                        byCustomerId[b.customer_id].totalSpent   += net;
                      }
                    }

                    // Update email-keyed customers with accurate aggregates.
                    const processedCustomerIds = new Set();
                    for (const [email, agg] of Object.entries(byEmail)) {
                      try {
                        const { existing } = await findMostRecentCustomerByEmail(sb, email);
                        if (!existing) continue;
                        processedCustomerIds.add(existing.id);
                        const totalBookings = agg.bookingCount;
                        const totalSpent    = Math.round(agg.totalSpent * 100) / 100;
                        await sb.from("customers")
                          .update({ total_bookings: totalBookings, total_spent: totalSpent, updated_at: new Date().toISOString() })
                          .eq("id", existing.id);
                        console.log(`v2-customers sync: corrected totals for ${email}: bookings=${totalBookings} spent=${totalSpent}`);
                      } catch (emailPatchErr) {
                        console.warn(`v2-customers sync: email-patch failed for ${email} (non-fatal):`, emailPatchErr.message);
                      }
                    }

                    // Update phone-keyed customers not already covered by email lookup.
                    const phones = phoneUpserts.map((u) => u.phone).filter(Boolean);
                    if (phones.length > 0) {
                      const { data: freshCustomers } = await sb
                        .from("customers")
                        .select("id, phone")
                        .in("phone", phones);
                      for (const cust of (freshCustomers || [])) {
                        if (processedCustomerIds.has(cust.id)) continue;
                        const agg = byCustomerId[cust.id];
                        if (!agg) continue;
                        const totalBookings = agg.bookingCount;
                        const totalSpent    = Math.round(agg.totalSpent * 100) / 100;
                        await sb.from("customers")
                          .update({ total_bookings: totalBookings, total_spent: totalSpent, updated_at: new Date().toISOString() })
                          .eq("id", cust.id);
                        console.log(`v2-customers sync: corrected totals for phone-keyed ${cust.id}: bookings=${totalBookings} spent=${totalSpent}`);
                      }
                    }
                  }
                } catch (bkCountErr) {
                  console.warn("v2-customers sync: join-based totals patch failed (non-fatal):", bkCountErr.message);
                }

                return res.status(200).json({ synced: totalCustomers, message: `Synced ${totalCustomers} customers from revenue records` });
              }
            }
          } else if (rrError) {
            console.warn("v2-customers sync: revenue_records query failed:", rrError.message);
          }
        } catch (sbSyncErr) {
          console.warn("v2-customers sync: Supabase sync error, falling back to bookings.json:", sbSyncErr.message);
        }
      }

      // Fallback: compute stats from bookings.json
      const { data: bookingsData } = await loadBookings();
      const allBookingsList = Object.values(bookingsData).flat();

      // Group bookings by email (primary), then phone fallback, then name.
      const byKey = {};
      for (const b of allBookingsList) {
        const rawPhone = (b.phone || "").trim();
        const phone    = rawPhone ? normalizePhone(rawPhone) : "";
        const email    = normalizeEmail(b.email);
        const normName = normalizeCustomerName(b.name);
        if (!email && !phone && !normName) continue;
        const name     = normName || "Unknown";
        const key = email ? `email:${email}` : (phone || `name:${name.toLowerCase()}`);
        if (!byKey[key]) byKey[key] = { name, phone: phone || null, email: email || null, bookings: [] };
        if (b.name)  byKey[key].name  = normalizeCustomerName(b.name) || byKey[key].name;
        if (email) byKey[key].email = email;
        if (!byKey[key].phone && phone) byKey[key].phone = phone;
        byKey[key].bookings.push(b);
      }

      const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

      const phoneUpserts   = [];
      const emailFallbacks = [];
      const nameFallbacks  = [];

      for (const [, c] of Object.entries(byKey)) {
        const paidBookings   = c.bookings.filter((b) => paidStatuses.has(b.status));
        const noShowBookings = c.bookings.filter((b) => b.isNoShow === true || b.no_show === true);
        const pickupDates    = c.bookings.map((b) => b.pickupDate).filter(Boolean).sort();
        const spent = paidBookings.reduce((s, b) => s + (Number(b.amountPaid || 0)), 0);
        const totalRentalDays = paidBookings.reduce((s, b) => s + computeRentalDays(b.pickupDate, b.returnDate), 0);
        const record = {
          name:                        normalizeCustomerName(c.name) || "Unknown",
          email:                       normalizeEmail(c.email),
          total_bookings:              paidBookings.length,
          total_spent:                 Math.round(spent * 100) / 100,
          total_gross_revenue:         Math.round(spent * 100) / 100,
          total_stripe_fees:           0,
          total_net_revenue:           Math.round(spent * 100) / 100,
          associated_vehicle_expenses: 0,
          total_profit:                Math.round(spent * 100) / 100,
          profit_per_booking:          paidBookings.length > 0 ? Math.round((spent / paidBookings.length) * 100) / 100 : 0,
          avg_profit_per_day:          totalRentalDays > 0 ? Math.round((spent / totalRentalDays) * 100) / 100 : 0,
          lifetime_value:              Math.round(spent * 100) / 100,
          no_show_count:               noShowBookings.length,
          first_booking_date:          pickupDates[0]  || null,
          last_booking_date:           pickupDates[pickupDates.length - 1] || null,
          updated_at:         new Date().toISOString(),
        };
        if (record.email) {
          emailFallbacks.push({ ...record, phone: c.phone || null, _emailKey: record.email });
        } else if (c.phone) {
          phoneUpserts.push({ ...record, phone: c.phone });
        } else {
          nameFallbacks.push(record);
        }
      }

      if (sb) {
        let schemaError = false;
        let synced = 0;

        if (phoneUpserts.length > 0) {
          const { error } = await sb.from("customers")
            .upsert(phoneUpserts, { onConflict: "phone", ignoreDuplicates: false });
          if (error) {
            if (!isSchemaError(error)) throw error;
            schemaError = true;
          } else {
            synced += phoneUpserts.length;
          }
        }

        if (!schemaError) {
          for (const record of emailFallbacks) {
            const { _emailKey: emailKey, ...cleanRecord } = record;
            try {
              const { existing, error: emailErr } = await findMostRecentCustomerByEmail(sb, emailKey);
              if (emailErr) {
                console.error("v2-customers sync email-lookup error:", emailErr.message);
                continue;
              }
              if (existing) {
                const { error } = await sb.from("customers").update(cleanRecord).eq("id", existing.id);
                if (error) { console.error("v2-customers sync email-update error:", error.message); continue; }
              } else {
                const { error } = await sb.from("customers").insert(cleanRecord);
                if (error) { console.error("v2-customers sync email-insert error:", error.message); continue; }
              }
              synced++;
            } catch (emailLookupErr) {
              console.error("v2-customers sync email-fallback error:", emailLookupErr.message);
            }
          }
        }

        if (!schemaError) {
          for (const record of nameFallbacks) {
            try {
              // Email-first lookup prevents creating a new row for a customer who
              // already exists (with any phone state). Fall back to case-insensitive
              // name matching (ilike) to catch case variations.
              let existing = null;
              if (record.email) {
                const { existing: existingByEmail, error: emailErr } = await findMostRecentCustomerByEmail(sb, record.email);
                if (!emailErr) existing = existingByEmail;
              }
              if (!existing) {
                // Use .limit(1) rather than .maybeSingle() so we don't get an
                // error when there happen to be multiple case-variant rows.
                const { data: nameRows } = await sb.from("customers")
                  .select("id").ilike("name", record.name).limit(1);
                existing = Array.isArray(nameRows) && nameRows.length > 0 ? nameRows[0] : null;
              }
              if (existing) {
                const { error } = await sb.from("customers").update(record).eq("id", existing.id);
                if (error) { console.error("v2-customers sync name-update error:", error.message); continue; }
              } else {
                const { error } = await sb.from("customers").insert({ ...record, phone: null });
                if (error) { console.error("v2-customers sync name-insert error:", error.message); continue; }
              }
              synced++;
            } catch (nameErr) {
              console.error("v2-customers sync name-fallback error:", nameErr.message);
            }
          }
          return res.status(200).json({ synced, message: `Synced ${synced} customers from bookings` });
        }
        console.warn("v2-customers sync: customers table missing, falling back to GitHub");
      }

      // GitHub fallback for sync
      const allRecords = [
        ...phoneUpserts,
        ...emailFallbacks.map(({ _emailKey, ...r }) => r),
        ...nameFallbacks.map((r) => ({ ...r, phone: null })),
      ];
      let synced = 0;
      await updateJsonFileWithRetry({
        load:    loadCustomersFromGitHub,
        apply:   (data) => {
          synced = 0;
          for (const r of allRecords) {
            const idx = r.email
              ? data.findIndex((c) => normalizeEmail(c.email) === r.email)
              : (r.phone
                ? data.findIndex((c) => c.phone === r.phone)
                : data.findIndex((c) => c.name === r.name && !c.phone));
            if (idx !== -1) {
              Object.assign(data[idx], r);
            } else {
              data.push({ id: randomUUID(), ...r, created_at: new Date().toISOString() });
            }
            synced++;
          }
        },
        save:    saveCustomersToGitHub,
        message: `v2: Sync ${allRecords.length} customers from bookings`,
      });
      return res.status(200).json({ synced, message: `Synced ${synced} customers from bookings` });
    }

    // ── RECOUNT — recalculate customer booking counts from the bookings table ─
    // This is the authoritative recount: reads customer_id links from the
    // bookings table so duplicate/orphan revenue_records can't inflate counts.
    // Also backfills bookings.customer_id for any rows that are missing a link
    // (matched by customer_email on the booking row → customers.email or phone).
    //
    // POST /api/v2-customers { secret, action:"recount" }
    if (action === "recount") {
      if (!sb) {
        return res.status(503).json({ error: "Supabase is not configured — recount requires database access." });
      }

      const updatedCustomers = [];
      const errors = [];

      try {
        // ── Step 1: backfill bookings.customer_id for unlinked rows ──────────
        // Fetch all bookings that have customer_email but no customer_id.
        const { data: unlinkedBookings, error: unlinkedErr } = await sb
          .from("bookings")
          .select("id, customer_email, customer_id")
          .is("customer_id", null)
          .not("customer_email", "is", null);

        if (unlinkedErr) {
          errors.push(`backfill-fetch: ${unlinkedErr.message}`);
        } else if (Array.isArray(unlinkedBookings) && unlinkedBookings.length > 0) {
          // Collect distinct emails to look up in one query
          const emails = [...new Set(unlinkedBookings.map((b) => b.customer_email.trim().toLowerCase()))];
          const { data: custByEmail, error: custEmailErr } = await sb
            .from("customers")
            .select("id, email")
            .in("email", emails);

          if (custEmailErr) {
            errors.push(`backfill-lookup: ${custEmailErr.message}`);
          } else if (Array.isArray(custByEmail) && custByEmail.length > 0) {
            const emailToId = new Map(custByEmail.map((c) => [c.email.toLowerCase(), c.id]));
            let backfilled = 0;
            for (const bk of unlinkedBookings) {
              const custId = emailToId.get(bk.customer_email.trim().toLowerCase());
              if (!custId) continue;
              const { error: patchErr } = await sb
                .from("bookings")
                .update({ customer_id: custId, updated_at: new Date().toISOString() })
                .eq("id", bk.id);
              if (patchErr) {
                errors.push(`backfill-patch(${bk.id}): ${patchErr.message}`);
              } else {
                backfilled++;
              }
            }
            console.log(`v2-customers recount: backfilled customer_id on ${backfilled} booking(s)`);
          }
        }

        // ── Step 2: fetch all customers ───────────────────────────────────────
        const { data: customers, error: custErr } = await sb
          .from("customers")
          .select("id, phone, email, name, total_bookings");

        if (custErr) {
          return res.status(500).json({ error: `Could not fetch customers: ${custErr.message}` });
        }
        if (!Array.isArray(customers) || customers.length === 0) {
          return res.status(200).json({ updated: 0, message: "No customers found — run sync first." });
        }

        // ── Step 3: count actual bookings per customer from the bookings table ─
        // Cancelled bookings are excluded (they never generated confirmed revenue).
        const CANCELLED_STATUSES = ["cancelled", "cancelled_rental"];
        const { data: bookingCounts, error: countErr } = await sb
          .from("bookings")
          .select("customer_id")
          .not("customer_id", "is", null)
          .not("status", "in", `(${CANCELLED_STATUSES.join(",")})`);

        if (countErr) {
          return res.status(500).json({ error: `Could not count bookings: ${countErr.message}` });
        }

        // Aggregate counts in JS (avoids needing a DB aggregation function)
        const countByCustomerId = {};
        for (const row of (bookingCounts || [])) {
          const cid = row.customer_id;
          countByCustomerId[cid] = (countByCustomerId[cid] || 0) + 1;
        }

        // ── Step 4: update each customer where total_bookings differs ─────────
        for (const cust of customers) {
          const accurate = countByCustomerId[cust.id] || 0;
          if (accurate === (cust.total_bookings || 0)) continue; // no change needed

          const { error: upErr } = await sb
            .from("customers")
            .update({ total_bookings: accurate, updated_at: new Date().toISOString() })
            .eq("id", cust.id);

          if (upErr) {
            errors.push(`update(${cust.id}): ${upErr.message}`);
          } else {
            updatedCustomers.push({
              id:   cust.id,
              name: cust.name,
              old:  cust.total_bookings,
              new:  accurate,
            });
            console.log(`v2-customers recount: ${cust.name} ${cust.total_bookings ?? "null"} → ${accurate}`);
          }
        }

        return res.status(200).json({
          updated:  updatedCustomers.length,
          changes:  updatedCustomers,
          errors:   errors.length > 0 ? errors : undefined,
          message:  updatedCustomers.length === 0
            ? "All booking counts are already accurate."
            : `Updated ${updatedCustomers.length} customer(s) with corrected booking counts.`,
        });
      } catch (recountErr) {
        console.error("v2-customers recount error:", recountErr);
        return res.status(500).json({ error: adminErrorMessage(recountErr) });
      }
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-customers error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
