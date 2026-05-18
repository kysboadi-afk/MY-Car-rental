import { patchRenterApplicationIdentityById } from "./_renter-applications.js";
import { sendIdentityVerifiedNotifications } from "./_application-notifications.js";
import { fetchVeriffDecision } from "./_veriff.js";

const NOTIFIABLE_APPLICATION_STATUSES = ["submitted", "under_review", "needs_info"];

export async function recoverVerifiedApplicationFromStripe(
  application = {},
  { reviewedBy = "veriff_identity_recovery", notify = true } = {},
) {
  const applicationId = typeof application?.id === "string" ? application.id : "";
  const identitySessionId = typeof application?.identity_session_id === "string"
    ? application.identity_session_id
    : "";

  if (!applicationId || !identitySessionId) {
    return { ok: true, synced: false, skipped: true, reason: "missing_identity_session" };
  }

  const decision = await fetchVeriffDecision(identitySessionId);
  if (!decision.ok) {
    const status = Number(decision.status) || null;
    const detailText = typeof decision.error === "string" && decision.error
      ? decision.error
      : (typeof decision.details === "string" ? decision.details : "");
    return {
      ok: false,
      synced: false,
      error: "Could not retrieve Veriff identity decision.",
      details: status
        ? `Veriff decision lookup failed (status ${status}): ${detailText}`.trim()
        : (detailText || ""),
    };
  }

  const recoveredIdentityStatus = decision.mappedStatus;
  if (!["verified", "processing"].includes(recoveredIdentityStatus)) {
    return { ok: true, synced: false, veriffStatus: decision.rawStatus || "unknown" };
  }

  const currentIdentityStatus = String(application.identity_status || "").toLowerCase();
  if (currentIdentityStatus === recoveredIdentityStatus) {
    return {
      ok: true,
      synced: false,
      veriffStatus: decision.rawStatus || "unknown",
      alreadySynced: true,
    };
  }

  const applicationStatus = String(application.application_status || "").toLowerCase();
  const shouldNotify = notify && recoveredIdentityStatus === "verified" && NOTIFIABLE_APPLICATION_STATUSES.includes(applicationStatus);
  const now = new Date().toISOString();
  const patch = {
    identitySessionId: decision.sessionId || identitySessionId,
    identityStatus: recoveredIdentityStatus,
  };
  if (recoveredIdentityStatus === "verified") {
    patch.identityVerifiedAt = now;
  }

  if (applicationStatus === "submitted") {
    patch.applicationStatus = "under_review";
    patch.reviewedAt = now;
    patch.reviewedBy = reviewedBy;
  }

  const patchResult = await patchRenterApplicationIdentityById(applicationId, patch);
  if (!patchResult.ok) {
    return {
      ok: false,
      synced: false,
      error: patchResult.error || "Could not update application.",
      details: patchResult.details || "",
    };
  }

  if (shouldNotify) {
    try {
      await sendIdentityVerifiedNotifications(patchResult.data || application);
    } catch (notifyErr) {
      console.error("recoverVerifiedApplicationFromStripe notification failed:", notifyErr);
    }
  }

  return {
    ok: true,
    synced: true,
    veriffStatus: decision.rawStatus || "approved",
    data: patchResult.data || application,
  };
}
