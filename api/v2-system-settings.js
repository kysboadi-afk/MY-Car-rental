// api/v2-system-settings.js
// SLYTRANS Fleet Control v2 — System settings management endpoint.
// Admin-controlled key/value configuration. Old booking/payment flows are unaffected.
//
// POST /api/v2-system-settings
// Actions:
//   list    — { secret, action:"list", category? }
//   get     — { secret, action:"get", key }
//   set     — { secret, action:"set", key, value, description?, category? }
//   delete  — { secret, action:"delete", key }
//
// Error contract:
//   • list/get return hardcoded defaults when Supabase is not configured or table missing.
//   • set/delete return 503 when Supabase is unavailable.
//   • When the table exists but is empty, defaults are auto-seeded on first list call.

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
}

// Hardcoded defaults matching the migration 0003 seed values.
// Used when Supabase is unavailable or the table is empty.
const DEFAULT_SETTINGS = [
  { key: "la_tax_rate",                 value: 0.1025,  description: "Los Angeles combined sales tax rate",             category: "tax" },
  // Slingshot tier rates (rental price before security deposit)
  { key: "slingshot_3hr_rate",          value: 200,     description: "Slingshot R 3-hour tier rate (USD)",              category: "pricing" },
  { key: "slingshot_6hr_rate",          value: 250,     description: "Slingshot R 6-hour tier rate (USD)",              category: "pricing" },
  { key: "slingshot_daily_rate",        value: 350,     description: "Slingshot R 1-day (24 hr) tier rate (USD)",       category: "pricing" },
  { key: "slingshot_2day_rate",         value: 700,     description: "Slingshot R 2-day (48 hr) tier rate (USD)",       category: "pricing" },
  { key: "slingshot_3day_rate",         value: 1050,    description: "Slingshot R 3-day (72 hr) tier rate (USD)",       category: "pricing" },
  // Camry / economy car rates
  { key: "camry_daily_rate",            value: 55,      description: "Camry daily rate (USD)",                          category: "pricing" },
  { key: "camry_weekly_rate",           value: 350,     description: "Camry weekly rate (USD)",                         category: "pricing" },
  { key: "camry_biweekly_rate",         value: 650,     description: "Camry bi-weekly rate (USD)",                      category: "pricing" },
  { key: "camry_monthly_rate",          value: 1300,    description: "Camry monthly rate (USD)",                        category: "pricing" },
  // Deposits / booking fees
  { key: "slingshot_security_deposit",  value: 150,     description: "Slingshot refundable security deposit (USD)",     category: "pricing" },
  { key: "slingshot_booking_deposit",   value: 50,      description: "Slingshot non-refundable booking deposit (USD)",  category: "pricing" },
  { key: "camry_booking_deposit",       value: 50,      description: "Camry non-refundable booking deposit (USD)",      category: "pricing" },
  { key: "auto_block_dates_on_approve", value: true,    description: "Auto-block vehicle dates when booking approved",  category: "automation" },
  { key: "auto_create_revenue_on_pay",  value: true,    description: "Auto-create revenue record when payment received",category: "automation" },
  { key: "auto_update_customer_stats",  value: true,    description: "Auto-update customer stats on booking events",    category: "automation" },
  { key: "notify_sms_on_approve",       value: true,    description: "Send SMS to customer when booking approved",      category: "notification" },
  { key: "notify_email_on_approve",     value: true,    description: "Send email to customer when booking approved",    category: "notification" },
  { key: "overdue_grace_period_hours",  value: 2,       description: "Hours after return time before booking flagged overdue", category: "automation" },
];

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
    if (!action || action === "list") {
      // Return hardcoded defaults when Supabase is not configured
      if (!sb) return res.status(200).json({ settings: DEFAULT_SETTINGS });

      try {
        let q = sb.from("system_settings").select("*").order("category").order("key");
        if (body.category) q = q.eq("category", body.category);
        const { data, error } = await q;
        if (error) {
          // Table may not exist yet — return defaults so the Settings page is usable
          console.error("v2-system-settings list error:", error.message);
          return res.status(200).json({ settings: DEFAULT_SETTINGS });
        }

        // If the table exists but is empty, auto-seed the defaults.
        // The upsert uses ignoreDuplicates:true so concurrent requests are safe —
        // the second request's upsert becomes a no-op on the already-seeded rows.
        if (!data || data.length === 0) {
          const seedRecords = DEFAULT_SETTINGS.map((s) => ({
            key:         s.key,
            value:       s.value,
            description: s.description,
            category:    s.category,
            updated_at:  new Date().toISOString(),
            updated_by:  "system",
          }));
          const { error: seedErr } = await sb.from("system_settings")
            .upsert(seedRecords, { onConflict: "key", ignoreDuplicates: true });
          if (seedErr) {
            console.error("v2-system-settings seed error (non-fatal):", seedErr.message);
          }
          // Re-fetch (or fall back to in-memory defaults on seed failure)
          const { data: seeded, error: refetchErr } = await sb.from("system_settings")
            .select("*").order("category").order("key");
          return res.status(200).json({ settings: refetchErr ? DEFAULT_SETTINGS : (seeded || DEFAULT_SETTINGS) });
        }

        return res.status(200).json({ settings: data });
      } catch (qErr) {
        console.error("v2-system-settings list query error:", qErr);
        return res.status(200).json({ settings: DEFAULT_SETTINGS });
      }
    }

    if (action === "get") {
      if (!body.key) return res.status(400).json({ error: "key is required" });
      if (!sb) {
        const def = DEFAULT_SETTINGS.find((s) => s.key === body.key);
        if (def) return res.status(200).json({ setting: def });
        return res.status(404).json({ error: "Setting not found" });
      }
      const { data, error } = await sb.from("system_settings").select("*").eq("key", body.key).single();
      if (error) throw error;
      return res.status(200).json({ setting: data });
    }

    if (action === "set") {
      const { key, value } = body;
      if (!key || value === undefined || value === null)
        return res.status(400).json({ error: "key and value are required and cannot be empty" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot save setting" });
      const record = {
        key:         String(key).trim(),
        value,
        updated_at:  new Date().toISOString(),
        updated_by:  "admin",
      };
      if (body.description) record.description = body.description;
      if (body.category)    record.category    = body.category;

      // Try UPDATE first (for existing rows); if no rows updated, INSERT the new row.
      // This avoids PostgREST upsert compatibility issues with keyword column names.
      const { data: updatedData, error: updateErr } = await sb
        .from("system_settings")
        .update(record)
        .eq("key", record.key)
        .select();

      if (updateErr) {
        // If the table is missing, attempt to auto-seed all defaults so that
        // subsequent saves work without requiring a manual Supabase migration.
        // (The seed only succeeds when the table has just been created and is
        // empty; if the table is truly absent this upsert will also fail and
        // the schema error will be surfaced to the admin.)
        if (isSchemaError(updateErr)) {
          const seedRecords = DEFAULT_SETTINGS.map((s) => ({
            key:         s.key,
            value:       s.value,
            description: s.description,
            category:    s.category,
            updated_at:  new Date().toISOString(),
            updated_by:  "system",
          }));
      await sb.from("system_settings")
            .upsert(seedRecords, { onConflict: "key", ignoreDuplicates: true })
            .select().then(({ error: seedErr }) => {
              if (seedErr) console.error("v2-system-settings auto-seed error:", seedErr.message);
            });

          // Retry the original update after seeding
          const { data: retryData, error: retryErr } = await sb
            .from("system_settings")
            .update(record)
            .eq("key", record.key)
            .select();
          if (retryErr) throw retryErr;

          if (retryData && retryData.length > 0) {
            return res.status(200).json({ setting: retryData[0] });
          }
          // Fall through to INSERT if still no row
          const { data: retryInsert, error: retryInsertErr } = await sb
            .from("system_settings")
            .insert(record)
            .select()
            .single();
          if (retryInsertErr) throw retryInsertErr;
          return res.status(200).json({ setting: retryInsert });
        }
        throw updateErr;
      }

      let finalData;
      if (updatedData && updatedData.length > 0) {
        finalData = updatedData[0];
      } else {
        // Row didn't exist — INSERT it
        const { data: insertedData, error: insertErr } = await sb
          .from("system_settings")
          .insert(record)
          .select()
          .single();
        if (insertErr) throw insertErr;
        finalData = insertedData;
      }

      return res.status(200).json({ setting: finalData });
    }

    if (action === "delete") {
      if (!body.key) return res.status(400).json({ error: "key is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot delete setting" });
      const { error } = await sb.from("system_settings").delete().eq("key", body.key);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-system-settings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
