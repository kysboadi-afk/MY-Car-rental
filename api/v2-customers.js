// api/v2-customers.js
// SLYTRANS Fleet Control v2 — Customer management endpoint.
// Customers are derived from booking history and stored additively in Supabase.
// Falls back to GitHub (customers.json) when Supabase is unavailable or tables missing.
//
// POST /api/v2-customers
// Actions:
//   list    — { secret, action:"list", banned?, flagged?, search? }
//   get     — { secret, action:"get", id }
//   upsert  — { secret, action:"upsert", phone, name, email?, ...fields } (create or update by phone)
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
          if (!error) return res.status(200).json({ customers: data || [] });
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
      if (!phone || !String(phone).trim()) return res.status(400).json({ error: "phone is required for upsert" });

      const record = {
        name: String(name).trim(),
        phone:      normalizePhone(String(phone).trim()),
        email:      email ? String(email).trim() : null,
        notes:      body.notes || null,
        updated_at: new Date().toISOString(),
      };

      if (sb) {
        try {
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
          const idx = data.findIndex((c) => c.phone === record.phone);
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
          const { data: rrData, error: rrError } = await sb
            .from("revenue_records_effective")
            .select("customer_phone, customer_name, customer_email, gross_amount, stripe_fee, stripe_net, refund_amount, is_cancelled, is_no_show, pickup_date, return_date, vehicle_id")
            .eq("payment_status", "paid");

          if (!rrError && Array.isArray(rrData) && rrData.length > 0) {
            // Group revenue records by the best available identity key, in priority order:
            //   1. Normalized phone (E.164) — most reliable deduplication key
            //   2. Normalized email (lowercase + trim) — for phone-less records
            //   3. Normalized name (lowercase + trim) — last-resort fallback
            // This ensures no revenue row is silently dropped.
            const byKey = {};
            for (const r of rrData) {
              const normPhone = r.customer_phone ? normalizePhone(r.customer_phone) : null;
              const normEmail = r.customer_email ? r.customer_email.toLowerCase().trim() : null;
              const normName  = r.customer_name  ? r.customer_name.toLowerCase().trim()  : null;

              let key;
              let keyType;
              if (normPhone) {
                key = normPhone;
                keyType = "phone";
              } else if (normEmail) {
                key = `email:${normEmail}`;
                keyType = "email";
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
                  name:  r.customer_name || "Unknown",
                  records: [],
                };
              }
              // Prefer the most complete values seen across all records for this key
              if (normPhone && !byKey[key].phone) byKey[key].phone = normPhone;
              if (normEmail && !byKey[key].email) byKey[key].email = normEmail;
              if (r.customer_name)                byKey[key].name  = r.customer_name;
              byKey[key].records.push(r);
            }

            // Pre-compute total rental days per vehicle across ALL records (for expense attribution).
            const vehicleTotalDays = {};
            for (const r of rrData) {
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
            //   phoneUpserts   — have a phone, upserted via onConflict:"phone"
            //   emailFallbacks — phone-less but have email, looked up by email
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

              if (cust.phone) {
                phoneUpserts.push({ ...record, phone: cust.phone });
              } else if (cust.email) {
                emailFallbacks.push({ ...record, phone: null, _emailKey: cust.email });
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

              // ── 2. Email-only records via individual lookup ───────────────
              if (!schemaError) {
                for (const record of emailFallbacks) {
                  const emailKey = record._emailKey;
                  const { _emailKey: _ignored, ...cleanRecord } = record;
                  try {
                    const { data: existing } = await sb.from("customers")
                      .select("id").eq("email", emailKey).is("phone", null).maybeSingle();
                    if (existing) {
                      const { error } = await sb.from("customers").update(cleanRecord).eq("id", existing.id);
                      if (error) { console.error("v2-customers sync email-update error:", error.message); }
                    } else {
                      const { error } = await sb.from("customers").insert({ ...cleanRecord, phone: null });
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
                    const { data: existing } = await sb.from("customers")
                      .select("id").eq("name", record.name).is("phone", null).maybeSingle();
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
                // ── Patch total_bookings from the bookings table ──────────────
                // revenue_records may include duplicates or missing records, so
                // the authoritative booking count comes from the bookings table.
                // This runs after the upsert so all customer rows exist with IDs.
                try {
                  const CANCELLED_STATUSES = ["cancelled", "cancelled_rental"];
                  const { data: bkRows } = await sb
                    .from("bookings")
                    .select("customer_id")
                    .not("customer_id", "is", null)
                    .not("status", "in", `(${CANCELLED_STATUSES.join(",")})`);

                  if (Array.isArray(bkRows) && bkRows.length > 0) {
                    const countById = {};
                    for (const row of bkRows) {
                      countById[row.customer_id] = (countById[row.customer_id] || 0) + 1;
                    }

                    // Fetch the IDs of the phone-keyed customers we just upserted
                    const phones = phoneUpserts.map((u) => u.phone);
                    const { data: freshCustomers } = await sb
                      .from("customers")
                      .select("id, phone, total_bookings")
                      .in("phone", phones);

                    for (const cust of (freshCustomers || [])) {
                      const accurate = countById[cust.id] || 0;
                      if (accurate !== (cust.total_bookings || 0)) {
                        await sb.from("customers")
                          .update({ total_bookings: accurate, updated_at: new Date().toISOString() })
                          .eq("id", cust.id);
                        console.log(`v2-customers sync: corrected total_bookings for ${cust.id}: ${cust.total_bookings} → ${accurate}`);
                      }
                    }
                  }
                } catch (bkCountErr) {
                  console.warn("v2-customers sync: bookings-table count patch failed (non-fatal):", bkCountErr.message);
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

      // Group bookings by phone or name
      const byKey = {};
      for (const b of allBookingsList) {
        const rawPhone = (b.phone || "").trim();
        const phone    = rawPhone ? normalizePhone(rawPhone) : "";
        const name     = (b.name  || "").trim();
        if (!phone && !name) continue;
        const key = phone || `name:${name.toLowerCase()}`;
        if (!byKey[key]) byKey[key] = { name, phone: phone || null, email: b.email || null, bookings: [] };
        if (b.name)  byKey[key].name  = b.name;
        if (b.email) byKey[key].email = b.email;
        byKey[key].bookings.push(b);
      }

      const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

      const phoneUpserts  = [];
      const nameFallbacks = [];

      for (const [, c] of Object.entries(byKey)) {
        const paidBookings   = c.bookings.filter((b) => paidStatuses.has(b.status));
        const noShowBookings = c.bookings.filter((b) => b.isNoShow === true || b.no_show === true);
        const pickupDates    = c.bookings.map((b) => b.pickupDate).filter(Boolean).sort();
        const spent = paidBookings.reduce((s, b) => s + (Number(b.amountPaid || 0)), 0);
        const totalRentalDays = paidBookings.reduce((s, b) => s + computeRentalDays(b.pickupDate, b.returnDate), 0);
        const record = {
          name:                        c.name  || "Unknown",
          email:                       c.email || null,
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
        if (c.phone) {
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
          for (const record of nameFallbacks) {
            try {
              const { data: existing } = await sb.from("customers")
                .select("id").eq("name", record.name).is("phone", null).maybeSingle();
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
      const allRecords = [...phoneUpserts, ...nameFallbacks.map((r) => ({ ...r, phone: null }))];
      let synced = 0;
      await updateJsonFileWithRetry({
        load:    loadCustomersFromGitHub,
        apply:   (data) => {
          synced = 0;
          for (const r of allRecords) {
            const idx = r.phone
              ? data.findIndex((c) => c.phone === r.phone)
              : data.findIndex((c) => c.name === r.name && !c.phone);
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
