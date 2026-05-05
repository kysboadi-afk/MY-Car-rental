// api/tickets.js
// SLYTRANS Fleet Control v2 — Tickets / Violations endpoint.
// Manages violation tickets linked to bookings and customers in Supabase.
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/tickets
// Actions:
//   create         — { secret, action:"create", ticketNumber, vehicleId, violationDate, amount, type, location?, notes? }
//   list           — { secret, action:"list", status?, vehicleId? }
//   get            — { secret, action:"get", id }
//   update_status  — { secret, action:"update_status", id, status }
//   add_note       — { secret, action:"add_note", id, note }
//   delete         — { secret, action:"delete", id }
//
// tickets.booking_id is a UUID FK to bookings.id (migration 0131).
// tickets.booking_ref is the human-readable booking_ref stored denormalised for display.

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const VALID_STATUSES = ["new","matched","transfer_ready","submitted","approved","rejected","charged","closed"];
const VALID_TYPES    = ["parking","toll","camera","other"];

const STATUS_LABELS = {
  new:            "New",
  matched:        "Matched",
  transfer_ready: "Transfer Ready",
  submitted:      "Submitted",
  approved:       "Approved",
  rejected:       "Rejected",
  charged:        "Charged",
  closed:         "Closed",
};

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  const { secret, action } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
  }

  try {
    switch (action) {
      case "create":        return await actionCreate(sb, body, res);
      case "list":          return await actionList(sb, body, res);
      case "get":           return await actionGet(sb, body, res);
      case "update_status": return await actionUpdateStatus(sb, body, res);
      case "add_note":      return await actionAddNote(sb, body, res);
      case "delete":        return await actionDelete(sb, body, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("tickets error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}

// ── CREATE ────────────────────────────────────────────────────────────────────

async function actionCreate(sb, body, res) {
  const {
    ticketNumber,
    vehicleId,
    violationDate,
    amount,
    type = "parking",
    location = "",
    notes = "",
  } = body;

  if (!ticketNumber || typeof ticketNumber !== "string" || !ticketNumber.trim()) {
    return res.status(400).json({ error: "ticketNumber is required" });
  }
  if (!vehicleId || typeof vehicleId !== "string") {
    return res.status(400).json({ error: "vehicleId is required" });
  }
  if (!violationDate) {
    return res.status(400).json({ error: "violationDate is required" });
  }
  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "amount must be a positive number" });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
  }

  const violationMs = new Date(violationDate).getTime();
  const violationDateStr = !isNaN(violationMs)
    ? new Date(violationDate).toISOString().slice(0, 10)
    : null;

  // Auto-match: find the booking covering the violation date, including extensions.
  // Broad query: vehicle bookings starting on/before the violation date and ending
  // no more than 90 days before it (generous window for late-issued tickets on
  // extended rentals).
  let matchedBooking = null;
  if (violationDateStr) {
    const windowStart = new Date(violationMs - 90 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    const { data: candidates } = await sb
      .from("bookings")
      .select("id, booking_ref, customer_id, pickup_date, return_date, status")
      .eq("vehicle_id", vehicleId)
      .lte("pickup_date", violationDateStr)
      .gte("return_date",  windowStart)
      .in("status", ["booked_paid", "active_rental", "active", "completed", "completed_rental", "approved"])
      .order("pickup_date", { ascending: false })
      .limit(10);

    if (candidates && candidates.length > 0) {
      // Batch-fetch all extensions for all candidates in one query to avoid
      // N sequential DB round-trips inside the loop.
      const candidateRefs = candidates.map((c) => c.booking_ref).filter(Boolean);
      let extensionsByRef = {};
      if (candidateRefs.length > 0) {
        const { data: allExts } = await sb
          .from("booking_extensions")
          .select("booking_id, new_return_date")
          .in("booking_id", candidateRefs);
        for (const ext of (allExts || [])) {
          const d = ext.new_return_date ? String(ext.new_return_date).split("T")[0] : "";
          if (!d) continue;
          if (!extensionsByRef[ext.booking_id] || d > extensionsByRef[ext.booking_id]) {
            extensionsByRef[ext.booking_id] = d;
          }
        }
      }

      for (const candidate of candidates) {
        // Direct return_date coverage
        if (candidate.return_date >= violationDateStr) {
          matchedBooking = candidate;
          break;
        }
        // Violation date is after base return_date — check extensions
        const maxExtDate = extensionsByRef[candidate.booking_ref] || "";
        const finalDate  = maxExtDate > candidate.return_date ? maxExtDate : candidate.return_date;
        if (finalDate >= violationDateStr) {
          matchedBooking = candidate;
          break;
        }
      }
    }
  }

  // Resolve customer info from matched booking
  let customerId   = null;
  let customerData = null;
  if (matchedBooking?.customer_id) {
    customerId = matchedBooking.customer_id;
    const { data: cust } = await sb
      .from("customers")
      .select("id, name, phone, email, license_front_url, license_back_url")
      .eq("id", customerId)
      .maybeSingle();
    if (cust) customerData = cust;
  }

  const status = matchedBooking ? "matched" : "new";
  const activityLog = [
    { date: new Date().toISOString(), action: "Ticket created", note: notes || "" },
  ];
  if (matchedBooking) {
    activityLog.push({
      date:   new Date().toISOString(),
      action: `Auto-matched to booking ${matchedBooking.booking_ref}`,
      note:   "",
    });
  }

  const { data: ticket, error: insertErr } = await sb
    .from("tickets")
    .insert({
      ticket_number:  ticketNumber.trim().slice(0, 80),
      vehicle_id:     vehicleId,
      booking_id:     matchedBooking?.id         || null,   // UUID FK to bookings.id
      booking_ref:    matchedBooking?.booking_ref || null,  // denorm text for display
      customer_id:    customerId,
      violation_date: new Date(violationDate).toISOString(),
      location:       String(location || "").trim().slice(0, 200),
      amount:         Math.round(parsedAmount * 100) / 100,
      type,
      status,
      notes:          String(notes || "").trim().slice(0, 1000),
      activity_log:   activityLog,
    })
    .select()
    .single();

  if (insertErr) throw insertErr;

  return res.status(200).json({
    success: true,
    ticket:  enrichTicket(ticket, customerData),
    matched: !!matchedBooking,
    matchedBookingId:   matchedBooking?.booking_ref || null,
    matchedRenterName:  customerData?.name          || null,
  });
}

// ── LIST ──────────────────────────────────────────────────────────────────────

async function actionList(sb, body, res) {
  const { status: filterStatus, vehicleId: filterVehicle } = body;

  let q = sb
    .from("tickets")
    .select(`
      *,
      customers!customer_id(id, name, phone, email, license_front_url, license_back_url)
    `)
    .order("created_at", { ascending: false });

  if (filterStatus && VALID_STATUSES.includes(filterStatus)) {
    q = q.eq("status", filterStatus);
  }
  if (filterVehicle && typeof filterVehicle === "string") {
    q = q.eq("vehicle_id", filterVehicle);
  }

  const { data, error } = await q;
  if (error) throw error;

  const tickets = (data || []).map((t) => {
    const { customers: cust, ...rest } = t;
    return enrichTicket(rest, cust);
  });

  return res.status(200).json({ success: true, tickets });
}

// ── GET ───────────────────────────────────────────────────────────────────────

async function actionGet(sb, body, res) {
  const { id } = body;
  if (!id) return res.status(400).json({ error: "id is required" });

  const { data: ticket, error } = await sb
    .from("tickets")
    .select(`
      *,
      customers!customer_id(id, name, phone, email, license_front_url, license_back_url, license_uploaded_at)
    `)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const { customers: cust, ...rest } = ticket;
  const enriched = enrichTicket(rest, cust);

  // Fetch booking documents by UUID booking_id
  let bookingDocs = [];
  if (ticket.booking_id) {
    const { data: docs } = await sb
      .from("booking_documents")
      .select("id, type, file_url, file_name, uploaded_at")
      .eq("booking_id", ticket.booking_id)
      .order("uploaded_at", { ascending: true });
    bookingDocs = docs || [];
  }

  return res.status(200).json({ success: true, ticket: enriched, bookingDocs });
}

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────

async function actionUpdateStatus(sb, body, res) {
  const { id, status } = body;
  if (!id) return res.status(400).json({ error: "id is required" });
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  const { data: existing, error: fetchErr } = await sb
    .from("tickets")
    .select("id, status, activity_log")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!existing) return res.status(404).json({ error: "Ticket not found" });

  const oldStatus   = existing.status;
  const activityLog = Array.isArray(existing.activity_log) ? existing.activity_log : [];
  activityLog.push({
    date:   new Date().toISOString(),
    action: `Status changed: ${STATUS_LABELS[oldStatus] || oldStatus} \u2192 ${STATUS_LABELS[status] || status}`,
    note:   "",
  });

  // Stamp transfer_submitted_at when first entering transfer_ready state
  const extra = {};
  if (status === "transfer_ready" && oldStatus !== "transfer_ready") {
    extra.transfer_submitted_at = new Date().toISOString();
  }

  const { data: updated, error: updateErr } = await sb
    .from("tickets")
    .update({ status, activity_log: activityLog, ...extra })
    .eq("id", id)
    .select()
    .single();
  if (updateErr) throw updateErr;

  return res.status(200).json({ success: true, ticket: enrichTicket(updated, null) });
}

// ── ADD NOTE ──────────────────────────────────────────────────────────────────

async function actionAddNote(sb, body, res) {
  const { id, note } = body;
  if (!id)   return res.status(400).json({ error: "id is required" });
  if (!note || !String(note).trim()) return res.status(400).json({ error: "note is required" });

  const { data: existing, error: fetchErr } = await sb
    .from("tickets")
    .select("id, activity_log")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!existing) return res.status(404).json({ error: "Ticket not found" });

  const activityLog = Array.isArray(existing.activity_log) ? existing.activity_log : [];
  activityLog.push({
    date:   new Date().toISOString(),
    action: "Note added",
    note:   String(note).trim().slice(0, 1000),
  });

  const { data: updated, error: updateErr } = await sb
    .from("tickets")
    .update({ activity_log: activityLog })
    .eq("id", id)
    .select()
    .single();
  if (updateErr) throw updateErr;

  return res.status(200).json({ success: true, ticket: enrichTicket(updated, null) });
}

// ── DELETE ────────────────────────────────────────────────────────────────────

async function actionDelete(sb, body, res) {
  const { id } = body;
  if (!id) return res.status(400).json({ error: "id is required" });

  const { error } = await sb.from("tickets").delete().eq("id", id);
  if (error) throw error;

  return res.status(200).json({ success: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Flatten a ticket row + optional customer join into a consistent shape
 * for the frontend.
 */
function enrichTicket(ticket, customer) {
  return {
    ...ticket,
    matchedRenterName:           customer?.name              || null,
    matchedRenterPhone:          customer?.phone             || null,
    matchedRenterEmail:          customer?.email             || null,
    matchedRenterLicenseUrl:     customer?.license_front_url || null,
    matchedRenterLicenseBackUrl: customer?.license_back_url  || null,
  };
}
