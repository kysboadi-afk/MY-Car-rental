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

const WEBSITE_SERVICE_KEY = "website_services";
const WEBSITE_INTEREST_STATUSES = new Set(["not_asked", "interested", "not_interested"]);
const WEBSITE_ACCEPTANCE_STATUSES = new Set(["not_offered", "offered", "accepted", "declined"]);
const WEBSITE_COMPLETION_STATUSES = new Set(["not_started", "in_progress", "completed"]);
const WEBSITE_STATUSES = new Set(["none", "hosted_booking_page", "custom_website", "external_website"]);

const WEBSITE_UPSELL_SELECT = [
  "organization_id",
  "service_key",
  "interest_status",
  "acceptance_status",
  "completion_status",
  "website_status",
  "selected_package_code",
  "package_snapshot",
  "offered_at",
  "accepted_at",
  "completed_at",
  "updated_by",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

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

function normalizeWebsiteInterestStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_INTEREST_STATUSES.has(status) ? status : "";
}

function normalizeWebsiteAcceptanceStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_ACCEPTANCE_STATUSES.has(status) ? status : "";
}

function normalizeWebsiteCompletionStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_COMPLETION_STATUSES.has(status) ? status : "";
}

function normalizeWebsiteStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_STATUSES.has(status) ? status : "";
}

function normalizeServiceKey(value) {
  const key = String(value || WEBSITE_SERVICE_KEY).trim().toLowerCase();
  return key || WEBSITE_SERVICE_KEY;
}

function defaultWebsiteUpsellState(organizationId) {
  return {
    organization_id: organizationId || null,
    service_key: WEBSITE_SERVICE_KEY,
    interest_status: "not_asked",
    acceptance_status: "not_offered",
    completion_status: "not_started",
    website_status: "none",
    selected_package_code: null,
    package_snapshot: null,
    offered_at: null,
    accepted_at: null,
    completed_at: null,
    updated_by: null,
    metadata: {},
    created_at: null,
    updated_at: null,
  };
}

function normalizeWebsiteUpsellState(row, organizationId) {
  const fallback = defaultWebsiteUpsellState(organizationId);
  const source = row && typeof row === "object" ? row : {};
  return {
    ...fallback,
    ...source,
    service_key: normalizeServiceKey(source.service_key || fallback.service_key),
    interest_status: normalizeWebsiteInterestStatus(source.interest_status) || fallback.interest_status,
    acceptance_status: normalizeWebsiteAcceptanceStatus(source.acceptance_status) || fallback.acceptance_status,
    completion_status: normalizeWebsiteCompletionStatus(source.completion_status) || fallback.completion_status,
    website_status: normalizeWebsiteStatus(source.website_status) || fallback.website_status,
    metadata: normalizeMetadata(source.metadata),
  };
}

function deriveWebsiteOnboardingStepStatus(upsell) {
  const completion = normalizeWebsiteCompletionStatus(upsell?.completion_status) || "not_started";
  const acceptance = normalizeWebsiteAcceptanceStatus(upsell?.acceptance_status) || "not_offered";
  const interest = normalizeWebsiteInterestStatus(upsell?.interest_status) || "not_asked";
  if (completion === "completed") return "completed";
  if (completion === "in_progress" || acceptance === "accepted" || acceptance === "offered" || interest === "interested") {
    return "in_progress";
  }
  return "not_started";
}

async function fetchWebsitePackageByCode(supabase, packageCode) {
  const code = String(packageCode || "").trim().toLowerCase();
  if (!code) return null;
  const { data, error } = await supabase
    .from("service_package_catalog")
    .select("service_key, package_code, package_name, deliverables, pricing_metadata, billing_metadata, version, is_active, metadata")
    .eq("service_key", WEBSITE_SERVICE_KEY)
    .eq("package_code", code)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || "Failed to load service package.");
  return data || null;
}

async function fetchActiveWebsitePackages(supabase) {
  const { data, error } = await supabase
    .from("service_package_catalog")
    .select("service_key, package_code, package_name, deliverables, pricing_metadata, billing_metadata, version, is_active, metadata")
    .eq("service_key", WEBSITE_SERVICE_KEY)
    .eq("is_active", true)
    .order("package_code", { ascending: true })
    .order("version", { ascending: false });
  if (error) {
    console.warn("v2-operator-leads package catalog load failed:", error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
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

async function ensureWebsiteUpsellState(supabase, { organizationId, actorId, now, source }) {
  const { data: existingState, error: existingError } = await supabase
    .from("organization_service_upsells")
    .select(WEBSITE_UPSELL_SELECT)
    .eq("organization_id", organizationId)
    .eq("service_key", WEBSITE_SERVICE_KEY)
    .maybeSingle();
  if (existingError) {
    throw new Error(existingError.message || "Failed to load website services upsell state.");
  }
  if (existingState) {
    return normalizeWebsiteUpsellState(existingState, organizationId);
  }

  const seedPayload = {
    organization_id: organizationId,
    service_key: WEBSITE_SERVICE_KEY,
    interest_status: "not_asked",
    acceptance_status: "not_offered",
    completion_status: "not_started",
    website_status: "none",
    updated_by: actorId || "legacy_admin",
    metadata: {
      seed_source: source || "operator_lead_conversion",
      seeded_at: now,
    },
  };

  const { error: upsertError } = await supabase
    .from("organization_service_upsells")
    .upsert(seedPayload, { onConflict: "organization_id,service_key" });
  if (upsertError) {
    throw new Error(upsertError.message || "Failed to seed website services upsell state.");
  }

  return normalizeWebsiteUpsellState(seedPayload, organizationId);
}

async function syncOrganizationWebsiteOnboardingStep(supabase, { organizationId, leadId, upsell, now, source }) {
  const { data: orgSettingsRow, error: settingsReadError } = await supabase
    .from("organization_settings")
    .select("settings")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (settingsReadError) {
    throw new Error(settingsReadError.message || "Failed to read organization settings.");
  }
  const currentSettings = normalizeMetadata(orgSettingsRow?.settings);
  const currentOnboarding = normalizeMetadata(currentSettings.onboarding);
  const currentSteps = normalizeMetadata(currentOnboarding.steps);
  const currentWebsiteStep = normalizeMetadata(currentSteps[WEBSITE_SERVICE_KEY]);
  const stepStatus = deriveWebsiteOnboardingStepStatus(upsell);

  const nextSettings = {
    ...currentSettings,
    onboarding: {
      ...currentOnboarding,
      bootstrap_state: currentOnboarding.bootstrap_state || "workspace_provisioned",
      source: currentOnboarding.source || source || "operator_lead_conversion",
      lead_id: currentOnboarding.lead_id || leadId || null,
      initialized_at: currentOnboarding.initialized_at || now,
      steps: {
        ...currentSteps,
        [WEBSITE_SERVICE_KEY]: {
          ...currentWebsiteStep,
          service_key: WEBSITE_SERVICE_KEY,
          status: stepStatus,
          tracked_at: currentWebsiteStep.tracked_at || now,
          updated_at: now,
          interest_status: upsell.interest_status,
          acceptance_status: upsell.acceptance_status,
          completion_status: upsell.completion_status,
          website_status: upsell.website_status,
          selected_package_code: upsell.selected_package_code || null,
        },
      },
    },
  };

  const { error: settingsWriteError } = await supabase
    .from("organization_settings")
    .upsert({
      organization_id: organizationId,
      settings: nextSettings,
    }, { onConflict: "organization_id" });
  if (settingsWriteError) {
    throw new Error(settingsWriteError.message || "Failed to update organization onboarding settings.");
  }
  return nextSettings;
}

function buildWebsiteUpsellKpis(leads) {
  const list = Array.isArray(leads) ? leads : [];
  let offered = 0;
  let accepted = 0;
  let declined = 0;
  let completed = 0;
  let interested = 0;

  for (const lead of list) {
    const state = normalizeWebsiteUpsellState(lead?.website_services, lead?.organization_id || null);
    if (state.interest_status === "interested") interested += 1;
    if (state.acceptance_status === "offered") offered += 1;
    if (state.acceptance_status === "accepted") accepted += 1;
    if (state.acceptance_status === "declined") declined += 1;
    if (state.completion_status === "completed") completed += 1;
  }

  return {
    total: list.length,
    interested,
    offered,
    accepted,
    declined,
    completed,
  };
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
    const leads = Array.isArray(data) ? data : [];
    const organizationIds = [...new Set(leads.map((lead) => lead?.organization_id).filter(Boolean))];
    const websiteStateByOrg = new Map();
    if (organizationIds.length) {
      const { data: upsellRows, error: upsellError } = await supabase
        .from("organization_service_upsells")
        .select(WEBSITE_UPSELL_SELECT)
        .eq("service_key", WEBSITE_SERVICE_KEY)
        .in("organization_id", organizationIds);
      if (upsellError) {
        console.warn("v2-operator-leads list website upsell load failed:", upsellError.message || upsellError);
      } else {
        for (const row of upsellRows || []) {
          if (!row?.organization_id) continue;
          websiteStateByOrg.set(
            row.organization_id,
            normalizeWebsiteUpsellState(row, row.organization_id)
          );
        }
      }
    }

    const leadsWithWebsite = leads.map((lead) => ({
      ...lead,
      website_services: websiteStateByOrg.get(lead?.organization_id) || defaultWebsiteUpsellState(lead?.organization_id || null),
    }));

    return res.status(200).json({
      leads: leadsWithWebsite,
      websiteServicesKpis: buildWebsiteUpsellKpis(leadsWithWebsite),
    });
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
            steps: {
              [WEBSITE_SERVICE_KEY]: {
                service_key: WEBSITE_SERVICE_KEY,
                status: "not_started",
                tracked_at: now,
                updated_at: now,
                interest_status: "not_asked",
                acceptance_status: "not_offered",
                completion_status: "not_started",
                website_status: "none",
                selected_package_code: null,
              },
            },
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
      workingProgress = setProgressTimestamp(workingProgress, "website_services_seeded_at", now);

      const seededUpsell = await ensureWebsiteUpsellState(supabase, {
        organizationId,
        actorId: req.authUser?.id || "legacy_admin",
        now,
        source: "operator_lead_conversion",
      });
      await syncOrganizationWebsiteOnboardingStep(supabase, {
        organizationId,
        leadId: lead.id,
        upsell: seededUpsell,
        now,
        source: "operator_lead_conversion",
      });

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
          websiteUpsellSeeded: true,
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

  if (
    action === "website_services_get_state"
    || action === "website_services_interest"
    || action === "website_services_offer"
    || action === "website_services_accept"
    || action === "website_services_decline"
    || action === "website_services_status"
    || action === "website_services_completion"
  ) {
    const id = normalizeId(req.body?.id);
    if (!id) return sendError(res, 400, "Missing lead id.");
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const { data: lead, error: leadError } = await supabase
      .from("operator_leads")
      .select("id, organization_id, funnel_stage, conversion_status, onboarding_progress")
      .eq("id", id)
      .maybeSingle();
    if (leadError) {
      console.error("v2-operator-leads website state lead lookup failed:", leadError.message || leadError);
      return sendError(res, 500, "Failed to load operator lead.");
    }
    if (!lead) return sendError(res, 404, "Lead not found.");
    if (!lead.organization_id) {
      return sendError(res, 400, "Website Services onboarding is available after workspace provisioning.");
    }

    const now = new Date().toISOString();
    const actorId = req.authUser?.id || "legacy_admin";
    let upsellState;
    try {
      upsellState = await ensureWebsiteUpsellState(supabase, {
        organizationId: lead.organization_id,
        actorId,
        now,
        source: "post_conversion_onboarding",
      });
    } catch (error) {
      return sendError(res, 500, "Failed to load Website Services state.", { reason: String(error?.message || error) });
    }

    if (action === "website_services_get_state") {
      try {
        const onboardingSettings = await syncOrganizationWebsiteOnboardingStep(supabase, {
          organizationId: lead.organization_id,
          leadId: lead.id,
          upsell: upsellState,
          now,
          source: "post_conversion_onboarding",
        });
        const packages = await fetchActiveWebsitePackages(supabase);
        return res.status(200).json({
          success: true,
          leadId: lead.id,
          organizationId: lead.organization_id,
          website_services: upsellState,
          onboarding: onboardingSettings?.onboarding || {},
          packages,
        });
      } catch (error) {
        return sendError(res, 500, "Failed to load onboarding state.", { reason: String(error?.message || error) });
      }
    }

    const updatePatch = {
      updated_by: actorId,
    };
    const metadataPatch = normalizeMetadata(upsellState.metadata);
    let auditEvent = "";

    if (action === "website_services_interest") {
      const nextInterestStatus = normalizeWebsiteInterestStatus(req.body?.interestStatus);
      if (!nextInterestStatus) return sendError(res, 400, "Invalid website interest status.");
      updatePatch.interest_status = nextInterestStatus;
      metadataPatch.interest_updated_at = now;
      metadataPatch.interest_updated_by = actorId;
      auditEvent = "website_services_interest_recorded";
    }

    if (action === "website_services_offer") {
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (currentAcceptance === "accepted") {
        return sendError(res, 409, "Cannot offer a new package after acceptance.");
      }
      if ((normalizeWebsiteInterestStatus(upsellState.interest_status) || "not_asked") === "not_interested") {
        return sendError(res, 409, "Cannot offer package when lead is marked not interested.");
      }
      const requestedPackageCode = String(req.body?.packageCode || "").trim().toLowerCase();
      if (requestedPackageCode) {
        try {
          const selectedPackage = await fetchWebsitePackageByCode(supabase, requestedPackageCode);
          if (!selectedPackage) return sendError(res, 404, "Package code not found.");
        } catch (error) {
          return sendError(res, 500, "Failed to validate package.", { reason: String(error?.message || error) });
        }
        updatePatch.selected_package_code = requestedPackageCode;
      }
      updatePatch.acceptance_status = "offered";
      updatePatch.offered_at = upsellState.offered_at || now;
      metadataPatch.offered_at = upsellState.offered_at || now;
      metadataPatch.offered_by = actorId;
      auditEvent = "website_services_package_offered";
    }

    if (action === "website_services_accept") {
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (currentAcceptance !== "offered" && currentAcceptance !== "accepted") {
        return sendError(res, 409, "Cannot accept package before it is offered.");
      }
      const packageCode = String(req.body?.packageCode || upsellState.selected_package_code || "").trim().toLowerCase();
      if (!packageCode) return sendError(res, 400, "Package code is required for acceptance.");
      let selectedPackage = null;
      try {
        selectedPackage = await fetchWebsitePackageByCode(supabase, packageCode);
      } catch (error) {
        return sendError(res, 500, "Failed to load package for acceptance.", { reason: String(error?.message || error) });
      }
      if (!selectedPackage) return sendError(res, 404, "Selected package is not active.");

      const acceptedAt = upsellState.accepted_at || now;
      updatePatch.acceptance_status = "accepted";
      updatePatch.selected_package_code = packageCode;
      updatePatch.accepted_at = acceptedAt;
      updatePatch.package_snapshot = {
        service_key: selectedPackage.service_key,
        package_code: selectedPackage.package_code,
        package_name: selectedPackage.package_name,
        deliverables: selectedPackage.deliverables,
        pricing_metadata: selectedPackage.pricing_metadata,
        billing_metadata: selectedPackage.billing_metadata,
        version: selectedPackage.version,
        captured_at: acceptedAt,
      };
      metadataPatch.accepted_at = acceptedAt;
      metadataPatch.accepted_by = actorId;
      auditEvent = "website_services_package_accepted";
    }

    if (action === "website_services_decline") {
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (currentAcceptance === "accepted") {
        return sendError(res, 409, "Cannot decline after package acceptance.");
      }
      updatePatch.acceptance_status = "declined";
      updatePatch.package_snapshot = null;
      metadataPatch.declined_at = now;
      metadataPatch.declined_by = actorId;
      auditEvent = "website_services_package_declined";
    }

    if (action === "website_services_status") {
      const nextWebsiteStatus = normalizeWebsiteStatus(req.body?.websiteStatus);
      if (!nextWebsiteStatus) return sendError(res, 400, "Invalid website status.");
      updatePatch.website_status = nextWebsiteStatus;
      metadataPatch.website_status_updated_at = now;
      metadataPatch.website_status_updated_by = actorId;
      auditEvent = "website_services_status_updated";
    }

    if (action === "website_services_completion") {
      const nextCompletionStatus = normalizeWebsiteCompletionStatus(req.body?.completionStatus || "completed");
      if (!nextCompletionStatus) return sendError(res, 400, "Invalid completion status.");
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (nextCompletionStatus === "completed" && currentAcceptance !== "accepted") {
        return sendError(res, 409, "Cannot mark Website Services complete before package acceptance.");
      }
      updatePatch.completion_status = nextCompletionStatus;
      if (nextCompletionStatus === "completed") {
        const completedAt = upsellState.completed_at || now;
        updatePatch.completed_at = completedAt;
        metadataPatch.completed_at = completedAt;
        metadataPatch.completed_by = actorId;
      } else {
        updatePatch.completed_at = null;
      }
      auditEvent = "website_services_completion_updated";
    }

    updatePatch.metadata = metadataPatch;
    const { data: updatedStateRaw, error: updateError } = await supabase
      .from("organization_service_upsells")
      .update(updatePatch)
      .eq("organization_id", lead.organization_id)
      .eq("service_key", WEBSITE_SERVICE_KEY)
      .select(WEBSITE_UPSELL_SELECT)
      .maybeSingle();
    if (updateError) {
      console.error("v2-operator-leads website state update failed:", updateError.message || updateError);
      return sendError(res, 500, "Failed to update Website Services state.");
    }

    const updatedState = normalizeWebsiteUpsellState(updatedStateRaw, lead.organization_id);
    let onboardingSettings = {};
    try {
      onboardingSettings = await syncOrganizationWebsiteOnboardingStep(supabase, {
        organizationId: lead.organization_id,
        leadId: lead.id,
        upsell: updatedState,
        now,
        source: "post_conversion_onboarding",
      });
    } catch (error) {
      return sendError(res, 500, "Website Services updated but onboarding sync failed.", { reason: String(error?.message || error) });
    }

    await insertLeadAuditLog(supabase, {
      lead_id: lead.id,
      event: auditEvent || "website_services_updated",
      outcome: "success",
      metadata: {
        organizationId: lead.organization_id,
        serviceKey: WEBSITE_SERVICE_KEY,
        interestStatus: updatedState.interest_status,
        acceptanceStatus: updatedState.acceptance_status,
        completionStatus: updatedState.completion_status,
        websiteStatus: updatedState.website_status,
        selectedPackageCode: updatedState.selected_package_code || null,
        actorId,
      },
    });

    return res.status(200).json({
      success: true,
      leadId: lead.id,
      organizationId: lead.organization_id,
      website_services: updatedState,
      onboarding: onboardingSettings?.onboarding || {},
    });
  }

  return sendError(res, 400, "Unsupported action.");
});
