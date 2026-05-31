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

const FUNNEL_STAGE_ORDER = [
  "lead_submitted",
  "notification_sent",
  "lead_managed",
  "lead_converted",
  "organization_created",
  "owner_account_created",
  "workspace_provisioned",
];

const FUNNEL_STAGE_RANK = Object.fromEntries(
  FUNNEL_STAGE_ORDER.map((stage, index) => [stage, index])
);

function normalizeLifecycleStage(value) {
  const key = String(value || "").trim().toLowerCase();
  return FUNNEL_STAGE_RANK[key] >= 0 ? key : "";
}

function mergeLifecycleStage(currentStage, nextStage) {
  const current = normalizeLifecycleStage(currentStage) || "lead_submitted";
  const next = normalizeLifecycleStage(nextStage);
  if (!next) return current;
  return FUNNEL_STAGE_RANK[next] >= FUNNEL_STAGE_RANK[current] ? next : current;
}

function normalizeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function setProgressTimestamp(progress, key, value) {
  const next = normalizeProgress(progress);
  const bucket = next.funnel_timestamps && typeof next.funnel_timestamps === "object" && !Array.isArray(next.funnel_timestamps)
    ? { ...next.funnel_timestamps }
    : {};
  if (!bucket[key]) bucket[key] = value;
  next.funnel_timestamps = bucket;
  return next;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildOrganizationSlug(lead) {
  const nameSlug = normalizeSlug(`${lead?.first_name || ""} ${lead?.last_name || ""}`);
  const leadSuffix = normalizeSlug(String(lead?.id || "").slice(0, 8));
  return `${nameSlug || "fleet-operator"}-${leadSuffix || "lead"}`.slice(0, 58);
}

async function insertLeadAuditLog(supabase, payload) {
  try {
    await supabase.from("operator_lead_audit_logs").insert(payload);
  } catch (error) {
    console.warn("v2-operator-leads audit insert skipped:", error?.message || error);
  }
}

function leadManagementStatusToStage(status, fallback) {
  if (status === "active_operator") return "lead_converted";
  if (status === "rejected") return fallback || "lead_managed";
  if (status === "contacted" || status === "demo_scheduled" || status === "onboarding") {
    return "lead_managed";
  }
  return fallback || "lead_submitted";
}

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
      .select("id, first_name, last_name, email, phone, fleet_size, status, notes, created_at, updated_at, funnel_stage, lead_submitted_at, notification_status, notification_channel, notification_sent_at, notification_last_attempt_at, notification_error_reason, lead_managed_at, lead_converted_at, organization_id, organization_created_at, owner_account_created_at, workspace_provisioned_at, conversion_status, conversion_error_reason")
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
      const currentStage = normalizeLifecycleStage(req.body?.currentFunnelStage);
      const nextStage = leadManagementStatusToStage(normalizedStatus, currentStage);
      updates.funnel_stage = mergeLifecycleStage(currentStage || "lead_submitted", nextStage);
      if (nextStage === "lead_managed") {
        updates.lead_managed_at = new Date().toISOString();
      }
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
      .select("id, status, notes, updated_at, funnel_stage, lead_managed_at")
      .maybeSingle();
    if (error) {
      console.error("v2-operator-leads update failed:", error.message || error);
      return sendError(res, 500, "Failed to update operator lead.");
    }
    if (!data) return sendError(res, 404, "Lead not found.");
    await insertLeadAuditLog(supabase, {
      lead_id: data.id,
      event: "lead_management_update",
      outcome: "success",
      metadata: {
        updatedFields: Object.keys(updates),
      },
    });
    return res.status(200).json({ success: true, lead: data });
  }

  if (action === "convert") {
    const id = normalizeId(req.body?.id);
    if (!id) return sendError(res, 400, "Missing lead id.");
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const now = new Date().toISOString();
    const { data: lead, error: leadError } = await supabase
      .from("operator_leads")
      .select("id, first_name, last_name, email, phone, fleet_size, source, status, notes, funnel_stage, onboarding_progress, metadata, organization_id, lead_submitted_at, notification_status, notification_sent_at, lead_managed_at, lead_converted_at, organization_created_at, owner_account_created_at, workspace_provisioned_at, conversion_status, conversion_error_reason")
      .eq("id", id)
      .maybeSingle();

    if (leadError) {
      console.error("v2-operator-leads convert lead lookup failed:", leadError.message || leadError);
      return sendError(res, 500, "Failed to load operator lead.");
    }
    if (!lead) return sendError(res, 404, "Lead not found.");

    if (lead.workspace_provisioned_at && lead.conversion_status === "succeeded") {
      return res.status(200).json({
        success: true,
        idempotent: true,
        lead,
      });
    }

    const progress = normalizeProgress(lead.onboarding_progress);
    const metadata = normalizeMetadata(lead.metadata);
    const conversionMeta = normalizeMetadata(metadata.conversion);
    const authUserEmail = String(req.authUser?.email || "").trim().toLowerCase();
    const leadEmail = String(lead.email || "").trim().toLowerCase();
    const ownerUserId = (req.authUser?.id && authUserEmail && leadEmail && authUserEmail === leadEmail)
      ? req.authUser.id
      : null;

    let currentStage = mergeLifecycleStage(lead.funnel_stage || "lead_submitted", "lead_converted");
    let workingProgress = setProgressTimestamp(progress, "lead_converted_at", lead.lead_converted_at || now);
    const patch = {
      status: "active_operator",
      funnel_stage: currentStage,
      lead_converted_at: lead.lead_converted_at || now,
      conversion_status: "in_progress",
      conversion_error_reason: null,
      onboarding_progress: workingProgress,
      metadata: {
        ...metadata,
        conversion: {
          ...conversionMeta,
          startedAt: conversionMeta.startedAt || now,
          startedBy: conversionMeta.startedBy || req.authUser?.id || "legacy_admin",
        },
      },
    };

    await supabase
      .from("operator_leads")
      .update(patch)
      .eq("id", id);

    try {
      let organizationId = lead.organization_id || null;
      let organizationCreatedAt = lead.organization_created_at || null;

      if (!organizationId) {
        const { data: existingOrg, error: existingOrgError } = await supabase
          .from("organizations")
          .select("id, created_at")
          .eq("owner_email", lead.email)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingOrgError) {
          console.error("v2-operator-leads convert org lookup failed:", existingOrgError.message || existingOrgError);
        }
        if (existingOrg?.id) {
          organizationId = existingOrg.id;
          organizationCreatedAt = existingOrg.created_at || now;
        }
      }

      if (!organizationId) {
        const slug = buildOrganizationSlug(lead);
        const orgPayload = {
          slug,
          name: `${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Fleet Operator"} Organization`,
          owner_email: lead.email,
          phone: lead.phone,
          status: "active",
          plan: "starter",
          metadata: {
            lead_id: lead.id,
            provisioning_source: "operator_lead_conversion",
          },
        };
        const { data: insertedOrg, error: insertOrgError } = await supabase
          .from("organizations")
          .insert(orgPayload)
          .select("id, created_at")
          .maybeSingle();

        if (insertOrgError) {
          const { data: slugOrg } = await supabase
            .from("organizations")
            .select("id, created_at")
            .eq("slug", slug)
            .maybeSingle();
          if (!slugOrg?.id) {
            throw new Error(insertOrgError.message || "Failed to create organization.");
          }
          organizationId = slugOrg.id;
          organizationCreatedAt = slugOrg.created_at || now;
        } else {
          organizationId = insertedOrg?.id || null;
          organizationCreatedAt = insertedOrg?.created_at || now;
        }
      }

      if (!organizationId) {
        throw new Error("Conversion failed: organization could not be resolved.");
      }

      currentStage = mergeLifecycleStage(currentStage, "organization_created");
      workingProgress = setProgressTimestamp(workingProgress, "organization_created_at", organizationCreatedAt || now);

      const ownerMembershipPayload = {
        organization_id: organizationId,
        email: lead.email,
        user_id: ownerUserId,
        role: "owner",
        status: "active",
        accepted_at: now,
        invited_at: lead.lead_submitted_at || now,
      };
      const { error: ownerError } = await supabase
        .from("organization_users")
        .upsert(ownerMembershipPayload, { onConflict: "organization_id,email" });
      if (ownerError) {
        throw new Error(ownerError.message || "Failed to create owner membership.");
      }

      currentStage = mergeLifecycleStage(currentStage, "owner_account_created");
      workingProgress = setProgressTimestamp(workingProgress, "owner_account_created_at", lead.owner_account_created_at || now);

      const workspacePayload = {
        organization_id: organizationId,
        settings: {
          notifications: {
            leadLifecycleEnabled: true,
          },
          onboarding: {
            bootstrap_state: "workspace_provisioned",
            source: "operator_lead_conversion",
            lead_id: lead.id,
            initialized_at: now,
          },
          operational: {
            timezone: "America/Los_Angeles",
          },
        },
      };
      const { error: workspaceError } = await supabase
        .from("organization_settings")
        .upsert(workspacePayload, { onConflict: "organization_id" });
      if (workspaceError) {
        throw new Error(workspaceError.message || "Failed to provision workspace defaults.");
      }

      currentStage = mergeLifecycleStage(currentStage, "workspace_provisioned");
      workingProgress = setProgressTimestamp(workingProgress, "workspace_provisioned_at", lead.workspace_provisioned_at || now);

      const finalPatch = {
        status: "active_operator",
        organization_id: organizationId,
        funnel_stage: currentStage,
        lead_converted_at: lead.lead_converted_at || now,
        organization_created_at: lead.organization_created_at || organizationCreatedAt || now,
        owner_account_created_at: lead.owner_account_created_at || now,
        workspace_provisioned_at: lead.workspace_provisioned_at || now,
        conversion_status: "succeeded",
        conversion_error_reason: null,
        onboarding_progress: workingProgress,
        metadata: {
          ...metadata,
          conversion: {
            ...conversionMeta,
            startedAt: conversionMeta.startedAt || now,
            completedAt: now,
            completedBy: req.authUser?.id || "legacy_admin",
            organizationId,
          },
        },
      };
      const { data: updatedLead, error: updateError } = await supabase
        .from("operator_leads")
        .update(finalPatch)
        .eq("id", id)
        .select("id, status, notes, updated_at, funnel_stage, lead_submitted_at, notification_status, notification_sent_at, lead_managed_at, lead_converted_at, organization_id, organization_created_at, owner_account_created_at, workspace_provisioned_at, conversion_status, conversion_error_reason")
        .maybeSingle();

      if (updateError) {
        throw new Error(updateError.message || "Failed to finalize converted lead.");
      }
      await insertLeadAuditLog(supabase, {
        lead_id: id,
        event: "lead_conversion_completed",
        outcome: "success",
        metadata: {
          organizationId,
          funnelStage: currentStage,
        },
      });
      return res.status(200).json({
        success: true,
        lead: updatedLead,
      });
    } catch (error) {
      const failureReason = String(error?.message || "Lead conversion failed.").slice(0, 500);
      await supabase
        .from("operator_leads")
        .update({
          conversion_status: "failed",
          conversion_error_reason: failureReason,
        })
        .eq("id", id);
      await insertLeadAuditLog(supabase, {
        lead_id: id,
        event: "lead_conversion_failed",
        outcome: "failed",
        detail: failureReason,
        metadata: {
          requestedBy: req.authUser?.id || "legacy_admin",
        },
      });
      return sendError(res, 500, "Lead conversion failed.", { reason: failureReason });
    }
  }

  return sendError(res, 400, "Unsupported action.");
});
