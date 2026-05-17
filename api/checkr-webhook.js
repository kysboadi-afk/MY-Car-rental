import {
  extractCheckrCandidate,
  extractCheckrEventType,
  extractCheckrMvrViolations,
  extractCheckrReport,
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
  if (!eventType) return res.status(200).json({ received: true, ignored: true });

  if (eventType === "candidate.created" || eventType === "invitation.completed") {
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
      checkrLastError: reportStatus === "error" ? eventType : null,
      checkrMvrViolations: extractCheckrMvrViolations(report),
    };

    if (eventType === "report.suspended") {
      patchPayload.checkrReportStatus = "suspended";
      patchPayload.checkrLastError = report?.status || eventType;
    } else if (eventType === "report.disputed") {
      patchPayload.checkrReportStatus = "disputed";
    }

    const patchResult = await patchRenterApplicationCheckrById(appResult.data.id, patchPayload);
    if (!patchResult.ok) {
      console.error("checkr-webhook patch failed:", patchResult.error, patchResult.details || "");
      return res.status(200).json({ received: true, ignored: true });
    }

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
