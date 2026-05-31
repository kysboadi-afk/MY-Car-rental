import { getSupabaseAdmin } from "./_supabase.js";
import { verifyOperatorDemoActionToken, hashOperatorDemoToken } from "./_operator-demo-token.js";

function sendJson(res, status, body) {
  return res.status(status).json(body);
}

function normalizeAction(value) {
  const action = String(value || "").trim().toLowerCase();
  if (["confirm", "reschedule", "cancel"].includes(action)) return action;
  return "";
}

async function writeAudit(supabase, leadId, event, metadata = {}) {
  if (!supabase || !leadId) return;
  try {
    await supabase.from("operator_lead_audit_logs").insert({
      lead_id: leadId,
      event,
      outcome: "success",
      metadata,
    });
  } catch (error) {
    console.warn("operator-lead-demo-action audit skipped:", error?.message || error);
  }
}

export default async function handler(req, res) {
  const action = normalizeAction(req.query?.action || req.body?.action);
  const token = String(req.query?.token || req.body?.token || "").trim();
  if (!action || !token) return sendJson(res, 400, { error: "Missing action or token." });

  const decoded = verifyOperatorDemoActionToken(token);
  if (!decoded || decoded.action !== action) {
    return sendJson(res, 401, { error: "Invalid or expired demo action token." });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return sendJson(res, 503, { error: "Supabase is not configured." });

  const { data: demo, error: demoError } = await supabase
    .from("operator_lead_demo_events")
    .select("id, lead_id, lifecycle_status, metadata")
    .eq("id", decoded.demoId)
    .eq("lead_id", decoded.leadId)
    .maybeSingle();

  if (demoError) return sendJson(res, 500, { error: "Failed to load demo event." });
  if (!demo) return sendJson(res, 404, { error: "Demo event not found." });

  const now = new Date().toISOString();
  const metadata = demo?.metadata && typeof demo.metadata === "object" && !Array.isArray(demo.metadata)
    ? { ...demo.metadata }
    : {};
  metadata.link_actions = metadata.link_actions && typeof metadata.link_actions === "object"
    ? { ...metadata.link_actions }
    : {};

  if (action === "confirm") {
    metadata.link_actions.confirmed_at = metadata.link_actions.confirmed_at || now;
    metadata.link_actions.confirmed_token_hash = hashOperatorDemoToken(token);
    const { error } = await supabase
      .from("operator_lead_demo_events")
      .update({ metadata, updated_at: now })
      .eq("id", demo.id)
      .eq("lead_id", demo.lead_id);
    if (error) return sendJson(res, 500, { error: "Failed to confirm demo." });
    await writeAudit(supabase, demo.lead_id, "demo_confirmation_link_clicked", {
      demoId: demo.id,
      action,
    });
    return sendJson(res, 200, { success: true, message: "Demo confirmed." });
  }

  if (action === "reschedule") {
    metadata.link_actions.reschedule_requested_at = now;
    metadata.link_actions.reschedule_requested_token_hash = hashOperatorDemoToken(token);
    const { error } = await supabase
      .from("operator_lead_demo_events")
      .update({
        lifecycle_status: demo.lifecycle_status === "proposed" ? "proposed" : "rescheduled",
        last_rescheduled_at: now,
        metadata,
        updated_at: now,
      })
      .eq("id", demo.id)
      .eq("lead_id", demo.lead_id);
    if (error) return sendJson(res, 500, { error: "Failed to request reschedule." });
    await writeAudit(supabase, demo.lead_id, "demo_reschedule_requested_via_link", {
      demoId: demo.id,
      action,
    });
    return sendJson(res, 200, { success: true, message: "Reschedule request submitted." });
  }

  const { error } = await supabase
    .from("operator_lead_demo_events")
    .update({
      lifecycle_status: "cancelled",
      cancelled_at: now,
      metadata: {
        ...metadata,
        link_actions: {
          ...metadata.link_actions,
          cancelled_at: now,
          cancelled_token_hash: hashOperatorDemoToken(token),
        },
      },
      updated_at: now,
    })
    .eq("id", demo.id)
    .eq("lead_id", demo.lead_id);

  if (error) return sendJson(res, 500, { error: "Failed to cancel demo." });

  await writeAudit(supabase, demo.lead_id, "demo_cancelled_via_link", {
    demoId: demo.id,
    action,
  });

  return sendJson(res, 200, { success: true, message: "Demo cancelled." });
}
