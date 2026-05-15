// api/send-application-email.js
// Vercel serverless function — emails the owner a new driver application
// containing the applicant's name, phone, age, driving experience, delivery
// apps, and a copy of their driver's license as an email attachment.
// Evaluates the application against pre-screen rules but binds owner/applicant
// messaging to the lifecycle state: submitted -> identity verification pending.
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST          — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT          — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER          — sending email address
//   SMTP_PASS          — email password or app password
//   OWNER_EMAIL        — business email that receives all applications
//                        (defaults to slyservices@supports-info.com)
//   TEXTMAGIC_USERNAME — TextMagic account username (optional; SMS skipped if absent)
//   TEXTMAGIC_API_KEY  — TextMagic API key
import { upsertContact } from "./_contacts.js";
import { insertRenterApplication, patchRenterApplicationById } from "./_renter-applications.js";
import { sendSubmittedApplicationNotifications } from "./_application-notifications.js";
import { normalizePhone } from "./_bookings.js";

// Allow large bodies — base64-encoded ID photos from mobile cameras can be
// 10 MB+ after encoding; 30 MB matches the store-booking-docs.js limit.
export const config = {
  api: { bodyParser: { sizeLimit: "30mb" } },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
// ~10 MB decoded — guard against oversized payloads
const MAX_LICENSE_B64_LEN = 14_000_000;

function normalizeApplicationId(value) {
  if (typeof value !== "string") return null;
  const out = value.trim();
  return out ? out : null;
}

// ─── Pre-approval logic ───────────────────────────────────────────────────────

/**
 * Evaluate a driver application.
 * @returns {"approved"|"review"|"declined"}
 */
function evaluateApplication({ age, experience, licenseAttached, agreeTerms }) {
  const ageNum = parseInt(age, 10);

  // Hard declines — applicant does not meet minimum requirements
  if (!isNaN(ageNum) && ageNum < 21) return "declined";
  if (experience === "Less than 3 months") return "declined";

  // Needs review — essential information is missing or incomplete
  if (!licenseAttached) return "review";
  if (!agreeTerms) return "review";
  if (isNaN(ageNum) || ageNum < 18) return "review";
  if (!experience) return "review";

  // All checks passed
  return "approved";
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("Missing SMTP environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS).");
    return res.status(500).json({ error: "Server configuration error: SMTP credentials are not set." });
  }

  const {
    applicationId,
    name, phone, email, age, experience, apps, agreeTerms,
    licenseFileName, licenseMimeType, licenseBase64,
    hasInsurance, insuranceBase64, insuranceFileName, insuranceMimeType,
    protectionPlanPref,
  } = req.body || {};

  if (!name || !phone || !experience) {
    return res
      .status(400)
      .json({ error: "Missing required fields: name, phone, experience." });
  }

  // Build attachment if a license image/PDF was provided
  const attachments = [];
  if (licenseBase64 && licenseFileName && licenseMimeType) {
    if (licenseBase64.length > MAX_LICENSE_B64_LEN) {
      return res.status(400).json({ error: "License file is too large." });
    }
    attachments.push({
      filename: licenseFileName,
      content: Buffer.from(licenseBase64, "base64"),
      contentType: licenseMimeType,
    });
  }

  // Attach insurance proof if provided
  if (insuranceBase64 && insuranceFileName && insuranceMimeType) {
    if (insuranceBase64.length > MAX_LICENSE_B64_LEN) {
      return res.status(400).json({ error: "Insurance file is too large." });
    }
    attachments.push({
      filename: insuranceFileName,
      content: Buffer.from(insuranceBase64, "base64"),
      contentType: insuranceMimeType,
    });
  }

  const hasLicense = attachments.length > 0;

  // ─── Pre-approval decision ──────────────────────────────────────────────────
  const decision = evaluateApplication({
    age, experience, licenseAttached: hasLicense, agreeTerms: !!agreeTerms,
  });

  let persistedApplicationId = normalizeApplicationId(applicationId);
  let applicationRecord = null;

  try {
    if (persistedApplicationId) {
      const patchResult = await patchRenterApplicationById(persistedApplicationId, {
        licenseBase64,
        licenseFileName,
        licenseMimeType,
        insuranceBase64,
        insuranceFileName,
        insuranceMimeType,
        precheckDecision: decision,
      });
      if (!patchResult.ok) {
        // Keep persistedApplicationId — the record was already created by
        // create-renter-application, so the ID is valid even if this
        // secondary patch (file names, precheck decision) failed.  Nulling
        // it here would cause the verification link to be omitted from the
        // email/SMS and would attempt a spurious duplicate insert below.
        console.warn("send-application-email: renter application patch skipped:", patchResult.error, patchResult.details || "");
      } else {
        applicationRecord = patchResult.data || null;
      }
    }
    if (!persistedApplicationId) {
      const createResult = await insertRenterApplication({
        name,
        phone,
        email,
        age,
        experience,
        apps,
        agreeTerms,
        agreeSmsConsent: !!(req.body && req.body.agreeSmsConsent),
        hasInsurance,
        protectionPlanPref,
        licenseBase64,
        licenseFileName,
        licenseMimeType,
        insuranceBase64,
        insuranceFileName,
        insuranceMimeType,
        precheckDecision: decision,
      });
      if (createResult.ok) {
        persistedApplicationId = createResult.data.id;
        applicationRecord = createResult.data || null;
      } else {
        console.warn("send-application-email: renter application create skipped:", createResult.error, createResult.details || "");
      }
    }
  } catch (persistErr) {
    console.warn("send-application-email: renter application persistence error:", persistErr.message || persistErr);
  }

  try {
    await sendSubmittedApplicationNotifications({
      ...(applicationRecord || {}),
      applicationId: persistedApplicationId || null,
      name,
      phone,
      email,
      age,
      experience,
      apps,
      agreeTerms,
      hasInsurance,
      protectionPlanPref,
      licenseFileName,
      insuranceFileName,
      hasLicenseUpload: hasLicense,
      hasInsuranceProof: !!(insuranceBase64 && insuranceFileName && insuranceMimeType),
      precheckDecision: decision,
      applicationStatus: applicationRecord?.application_status || "submitted",
      identityStatus: applicationRecord?.identity_status || "not_started",
    }, { attachments });

    // ─── TextMagic contact upsert ─────────────────────────────────────────────
    if (phone) {
      try {
        await upsertContact(normalizePhone(phone), name || "", { addTags: ["application"] });
      } catch (contactErr) {
        console.error("TextMagic contact upsert failed:", contactErr);
      }
    }

    return res.status(200).json({
      success: true,
      decision,
      precheckDecision: decision,
      applicationId: persistedApplicationId || null,
      applicationStatus: applicationRecord?.application_status || "submitted",
      identityStatus: applicationRecord?.identity_status || "not_started",
    });
  } catch (err) {
    console.error("Application email failed:", err);
    return res.status(500).json({ error: "Failed to send application email." });
  }
}
