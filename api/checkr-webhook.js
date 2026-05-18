import {
  extractCheckrCandidate,
  extractCheckrEventType,
  extractCheckrMvrViolations,
  extractCheckrReport,
  logCheckrEvent,
  mapCheckrReportStatus,
  verifyCheckrWebhookSignature,
} from "./_checkr.js";
import {
  fetchRenterApplicationByCheckrCandidateId,
  fetchRenterApplicationByCheckrReportId,
  patchRenterApplicationCheckrById,
} from "./_renter-applications.js";
import { sendCheckrStatusNotifications } from "./_application-notifications.js";

export const config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function redactId(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-3)}`;
}

async function findApplicationForPayload(payload = {}) {
  const report = extractCheckrReport(payload);
  const candidate = extractCheckrCandidate(payload);
  const reportId = report?.id || payload?.report_id;
  const candidateId = report?.candidate_id || candidate?.id || payload?.candidate_id;

  if (reportId) {
    const byReport = await fetchRenterApplicationByCheckrReportId(reportId);
    if (byReport.ok) return byReport;
  }
  if (candidateId) {
    const byCandidate = await fetchRenterApplicationByCheckrCandidateId(candidateId);
    if (byCandidate.ok) return byCandidate;
  }
  return { ok: false, status: 404, error: "Application not found." };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  if (!process.env.CHECKR_WEBHOOK_SECRET) {
    return res.status(500).send("Server configuration error");
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("checkr-webhook failed to read body:", err);
    return res.status(400).send("Invalid request body");
  }

  if (!verifyCheckrWebhookSignature(rawBody, req.headers, process.env.CHECKR_WEBHOOK_SECRET)) {
    return res.status(400).send("Webhook Error: signature verification failed");
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return res.status(400).send("Webhook Error: invalid JSON");
  }

  const eventType = extractCheckrEventType(payload);
  const eventAt = new Date().toISOString();
  console.info("checkr-webhook: event received", {
    eventType: eventType || null,
    eventId: payload?.id || null,
  });
  if (!eventType) return res.status(200).json({ received: true, ignored: true });

  await logCheckrEvent({
    eventId: pickEventId(payload, eventType),
    eventType: `webhook.${eventType}`,
    applicationId: null,
    candidateId: extractCheckrCandidate(payload)?.id || null,
    reportId: extractCheckrReport(payload)?.id || null,
    phase: null,
    payload,
  });

  if (eventType === "candidate.created" || eventType === "invitation.completed") {
    const appResult = await findApplicationForPayload(payload);
    if (appResult.ok) {
      await patchRenterApplicationCheckrById(appResult.data.id, {
        checkrCandidateId: extractCheckrCandidate(payload)?.id || appResult.data?.checkr_candidate_id || null,
        checkrReportId: extractCheckrReport(payload)?.id || appResult.data?.checkr_report_id || null,
        checkrReportStatus: eventType === "candidate.created" ? "candidate_created" : "pending",
        checkrPhase: eventType === "candidate.created" ? "candidate_created" : "pending",
        checkrLastWebhookAt: eventAt,
      }).catch(() => {});
    }
    console.info("checkr-webhook: non-terminal event acknowledged", {
      eventType,
      eventId: payload?.id || null,
    });
    return res.status(200).json({ received: true, logged: true });
  }

  try {
    const appResult = await findApplicationForPayload(payload);
    if (!appResult.ok) {
      console.warn("checkr-webhook application lookup failed:", appResult.error);
      return res.status(200).json({ received: true, ignored: true });
    }

    const report = extractCheckrReport(payload);
    const reportStatus = mapCheckrReportStatus(report?.status, report?.adjudication);
    const patchPayload = {
      checkrCandidateId: report?.candidate_id || extractCheckrCandidate(payload)?.id || appResult.data?.checkr_candidate_id || null,
      checkrReportId: report?.id || appResult.data?.checkr_report_id || null,
      checkrAdjudication: report?.adjudication || null,
      checkrCompletedAt: report?.completed_at || payload?.created_at || new Date().toISOString(),
      checkrReportStatus: reportStatus,
      checkrPhase: reportStatus,
      checkrLastError: reportStatus === "failed" ? eventType : null,
      checkrMvrViolations: extractCheckrMvrViolations(report),
      checkrLastWebhookAt: eventAt,
    };

    if (eventType === "report.suspended") {
      patchPayload.checkrReportStatus = "suspended";
      patchPayload.checkrPhase = "suspended";
      patchPayload.checkrLastError = report?.status || eventType;
    } else if (eventType === "report.disputed") {
      patchPayload.checkrReportStatus = "suspended";
      patchPayload.checkrPhase = "suspended";
      patchPayload.checkrLastError = eventType;
    }

    console.info("checkr-webhook: applying status update", {
      applicationId: appResult.data?.id || null,
      eventType,
      previousStatus: appResult.data?.checkr_report_status || null,
      nextStatus: patchPayload.checkrReportStatus || null,
      reportId: redactId(patchPayload.checkrReportId),
      candidateId: redactId(patchPayload.checkrCandidateId),
    });

    const patchResult = await patchRenterApplicationCheckrById(appResult.data.id, patchPayload);
    if (!patchResult.ok) {
      console.error("checkr-webhook patch failed:", patchResult.error, patchResult.details || "");
      await logCheckrEvent({
        eventId: `${pickEventId(payload, eventType)}:patch-failed`,
        eventType: "webhook.patch_failed",
        applicationId: appResult.data.id,
        candidateId: patchPayload.checkrCandidateId,
        reportId: patchPayload.checkrReportId,
        phase: "failed",
        payload: { error: patchResult.error || null, details: patchResult.details || null, eventType },
      });
      return res.status(200).json({ received: true, ignored: true });
    }
    console.info("checkr-webhook: status update persisted", {
      applicationId: patchResult.data?.id || appResult.data?.id || null,
      eventType,
      checkrReportStatus: patchResult.data?.checkr_report_status || patchPayload.checkrReportStatus || null,
      applicationStatus: patchResult.data?.application_status || appResult.data?.application_status || null,
      reportId: redactId(patchResult.data?.checkr_report_id || patchPayload.checkrReportId),
      candidateId: redactId(patchResult.data?.checkr_candidate_id || patchPayload.checkrCandidateId),
    });
    await logCheckrEvent({
      eventId: `${pickEventId(payload, eventType)}:patched`,
      eventType: "webhook.patched",
      applicationId: patchResult.data?.id || appResult.data?.id || null,
      candidateId: patchResult.data?.checkr_candidate_id || patchPayload.checkrCandidateId || null,
      reportId: patchResult.data?.checkr_report_id || patchPayload.checkrReportId || null,
      phase: patchPayload.checkrReportStatus,
      payload: { eventType, reportStatus: patchPayload.checkrReportStatus },
    });

    if (["report.completed", "report.suspended", "report.disputed"].includes(eventType)) {
      try {
        await sendCheckrStatusNotifications(patchResult.data, {
          eventType,
          reportStatus: patchPayload.checkrReportStatus,
        });
      } catch (notifyErr) {
        console.error("checkr-webhook notification failed:", notifyErr.message || notifyErr);
      }
    }
  } catch (err) {
    console.error("checkr-webhook processing failed:", err);
  }

  return res.status(200).json({ received: true });
}

function pickEventId(payload = {}, eventType = "") {
  const direct = String(payload?.id || "").trim();
  if (direct) return direct;
  const report = extractCheckrReport(payload);
  const candidate = extractCheckrCandidate(payload);
  const createdAt = String(payload?.created_at || payload?.createdAt || "").trim();
  return [
    eventType || "unknown-event",
    String(report?.id || payload?.report_id || "").trim() || "no-report",
    String(report?.candidate_id || candidate?.id || payload?.candidate_id || "").trim() || "no-candidate",
    createdAt || "no-time",
  ].join(":");
}
