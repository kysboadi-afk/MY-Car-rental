import { getSupabaseAdmin } from "./_supabase.js";
import { sendError, withAdminAuth } from "./_middleware.js";

const STATUS_INPUT_MAP = {
  new_lead: "new_lead",
  "new lead": "new_lead",
  contacted: "contacted",
  demo_scheduled: "demo_scheduled",
  "demo scheduled": "demo_scheduled",
  onboarding: "onboarding",
  qualified: "onboarding",
  active_operator: "active_operator",
  converted: "active_operator",
  rejected: "rejected",
  closed: "rejected",
};

function normalizeId(value) {
  return String(value || "").trim().slice(0, 128);
}

function normalizeNotes(value) {
  return String(value || "").trim().slice(0, 4000);
}

function normalizeStatus(value) {
  const key = String(value || "").trim().toLowerCase();
  return STATUS_INPUT_MAP[key] || "";
}

export default withAdminAuth(async function handler(req, res) {
  const { action = "list" } = req.body || {};
  const supabase = getSupabaseAdmin();

  if (action === "list") {
    if (!supabase) return res.status(200).json({ leads: [] });
    const { data, error } = await supabase
      .from("operator_leads")
      .select("id, first_name, last_name, email, phone, fleet_size, status, notes, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      console.error("v2-operator-leads list failed:", error.message || error);
      return sendError(res, 500, "Failed to load operator leads.");
    }
    return res.status(200).json({ leads: Array.isArray(data) ? data : [] });
  }

  if (action === "update") {
    const id = normalizeId(req.body?.id);
    if (!id) return sendError(res, 400, "Missing lead id.");

    const updates = {};
    if ("status" in (req.body || {})) {
      const normalizedStatus = normalizeStatus(req.body?.status);
      if (!normalizedStatus) return sendError(res, 400, "Invalid lead status.");
      updates.status = normalizedStatus;
    }
    if ("notes" in (req.body || {})) {
      updates.notes = normalizeNotes(req.body?.notes);
    }
    if (!Object.keys(updates).length) {
      return sendError(res, 400, "Nothing to update.");
    }
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const { data, error } = await supabase
      .from("operator_leads")
      .update(updates)
      .eq("id", id)
      .select("id, status, notes, updated_at")
      .maybeSingle();
    if (error) {
      console.error("v2-operator-leads update failed:", error.message || error);
      return sendError(res, 500, "Failed to update operator lead.");
    }
    if (!data) return sendError(res, 404, "Lead not found.");
    return res.status(200).json({ success: true, lead: data });
  }

  return sendError(res, 400, "Unsupported action.");
});
