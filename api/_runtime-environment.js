const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const KNOWN_ENVS = new Set(["production", "staging", "development", "test"]);

function normalizeEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return KNOWN_ENVS.has(normalized) ? normalized : "";
}

export function getRuntimeEnvironment() {
  const explicit =
    normalizeEnv(process.env.APP_ENV) ||
    normalizeEnv(process.env.RUNTIME_ENV) ||
    normalizeEnv(process.env.DEPLOY_ENV) ||
    normalizeEnv(process.env.ENVIRONMENT);
  if (explicit) return explicit;

  if (process.env.NODE_ENV === "test") return "test";

  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  if (vercelEnv === "preview") return "staging";
  if (vercelEnv === "development") return "development";

  return "production";
}

export function maybeSkipScheduledAutomation(req, res, { endpoint }) {
  const method = String(req?.method || "").toUpperCase();
  if (method !== "GET") return false;

  const env = getRuntimeEnvironment();
  if (env !== "staging") return false;

  const allowStagingAutomation = TRUE_VALUES.has(
    String(process.env.ENABLE_STAGING_AUTOMATION || "").trim().toLowerCase()
  );
  if (allowStagingAutomation) return false;

  console.log(`${endpoint}: skipping scheduled automation in staging environment`);
  res.status(200).json({
    skipped: true,
    reason: "staging_automation_disabled",
    environment: env,
    endpoint,
  });
  return true;
}
