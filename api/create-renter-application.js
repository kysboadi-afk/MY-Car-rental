import { insertRenterApplication, toClientApplication } from "./_renter-applications.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const payload = req.body || {};
    console.info("create-renter-application: submit received", {
      hasName: !!payload.name,
      hasPhone: !!payload.phone,
      hasExperience: !!payload.experience,
      hasEmail: !!payload.email,
      hasAgreeTerms: !!payload.agreeTerms,
      hasAgreeSmsConsent: !!payload.agreeSmsConsent,
      hasAgreeBackgroundCheck: !!payload.agreeBackgroundCheck,
    });

    const result = await insertRenterApplication(req.body || {});
    if (!result.ok) {
      if (result.details) console.error("create-renter-application failed:", result.details);
      return res.status(result.status || 500).json({ error: result.error || "Failed to create application." });
    }

    console.info("create-renter-application: submit stored", {
      applicationId: result.data?.id || null,
      applicationStatus: result.data?.application_status || null,
      identityStatus: result.data?.identity_status || null,
    });

    return res.status(200).json({
      success: true,
      ...toClientApplication(result.data),
    });
  } catch (err) {
    console.error("create-renter-application unexpected error:", err);
    return res.status(500).json({ error: "Failed to create application." });
  }
}
