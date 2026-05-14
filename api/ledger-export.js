// api/ledger-export.js
// Phase 4.5 — Accounting export / statements.
//
// Exports ledger transactions per booking or per customer in CSV or JSON format.
// Includes a running balance column so each row shows the balance after the
// transaction was applied.
//
// POST /api/ledger-export  (admin secret required)
//
// Body:
//   {
//     secret,
//     booking_id?,         // filter to a single booking
//     customer_id?,        // filter to all bookings for a customer
//     customer_email?,     // alternative customer filter (resolves via bookings table)
//     format?,             // "json" (default) | "csv"
//     date_from?,          // ISO date filter on created_at
//     date_to?,            // ISO date filter on created_at
//     include_running_balance?  // bool, default true
//   }
//
// CSV headers:
//   date, booking_ref, transaction_type, direction, amount, running_balance,
//   source_type, source_id, notes, created_by
//
// Running balance: computed left-to-right in ascending created_at order.
//   debits  → increase balance
//   credits → decrease balance

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const MAX_ROWS = 10000;

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  const bookingId = body.booking_id || body.booking_ref || null;
  const customerId = body.customer_id || null;
  const customerEmail = body.customer_email || null;
  const format = (body.format || "json").toLowerCase();
  const dateFrom = body.date_from || null;
  const dateTo = body.date_to || null;
  const includeRunningBalance = body.include_running_balance !== false;

  if (!["json", "csv"].includes(format)) {
    return res.status(400).json({ error: 'format must be "json" or "csv"' });
  }

  // Resolve customer_id from email if provided.
  let resolvedCustomerId = customerId;
  if (!resolvedCustomerId && customerEmail) {
    const { data: bkRow } = await sb
      .from("bookings")
      .select("customer_id")
      .eq("customer_email", customerEmail)
      .not("customer_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (bkRow) resolvedCustomerId = bkRow.customer_id;
  }

  if (!bookingId && !resolvedCustomerId) {
    return res.status(400).json({ error: "booking_id, customer_id, or customer_email is required" });
  }

  try {
    let q = sb
      .from("renter_balance_ledger")
      .select("id, booking_id, transaction_type, direction, amount, source_type, source_id, notes, created_by, created_at, metadata, due_date")
      .order("created_at", { ascending: true })
      .limit(MAX_ROWS);

    if (bookingId) q = q.eq("booking_id", bookingId);
    if (resolvedCustomerId) q = q.eq("customer_id", resolvedCustomerId);
    if (dateFrom) q = q.gte("created_at", dateFrom);
    if (dateTo) q = q.lte("created_at", dateTo + "T23:59:59Z");

    const { data: rows, error } = await q;
    if (error) throw new Error(`Ledger export query failed: ${error.message}`);

    const txList = rows || [];

    // Compute running balance.
    let runningBalanceCents = 0;
    const enriched = txList.map((row) => {
      const amountCents = Math.round(Number(row.amount || 0) * 100);
      if (row.direction === "debit") {
        runningBalanceCents += amountCents;
      } else {
        runningBalanceCents -= amountCents;
      }
      const running = Math.round(runningBalanceCents) / 100;
      return {
        date: row.created_at ? row.created_at.slice(0, 10) : "",
        booking_ref: row.booking_id,
        transaction_type: row.transaction_type,
        direction: row.direction,
        amount: Number(row.amount),
        ...(includeRunningBalance ? { running_balance: running } : {}),
        source_type: row.source_type || "",
        source_id: row.source_id || "",
        due_date: row.due_date || "",
        notes: row.notes || "",
        created_by: row.created_by || "",
        id: row.id,
      };
    });

    if (format === "json") {
      return res.status(200).json({
        ok: true,
        booking_id: bookingId || null,
        customer_id: resolvedCustomerId || null,
        count: enriched.length,
        transactions: enriched,
      });
    }

    // CSV output.
    const headers = [
      "date", "booking_ref", "transaction_type", "direction", "amount",
      ...(includeRunningBalance ? ["running_balance"] : []),
      "source_type", "source_id", "due_date", "notes", "created_by", "id",
    ];
    const csvLines = [headers.join(",")];
    for (const row of enriched) {
      csvLines.push(headers.map((h) => csvEscape(String(row[h] ?? ""))).join(","));
    }
    const csv = csvLines.join("\n");

    const filename = bookingId
      ? `ledger-${bookingId}.csv`
      : `ledger-customer-${(resolvedCustomerId || "unknown").slice(0, 8)}.csv`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error("[ledger-export] error:", err.message);
    return res.status(500).json({ error: "Export failed.", detail: err.message });
  }
}

function csvEscape(value) {
  if (/[,"\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
