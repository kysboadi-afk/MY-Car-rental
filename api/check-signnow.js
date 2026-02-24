// api/check-signnow.js
// Vercel serverless function — diagnostic endpoint for SignNow configuration
//
// GET /api/check-signnow
//   Returns a JSON report showing which env vars are set, whether authentication
//   works, and whether the template is accessible.
//   No sensitive values are ever exposed — only "set" / "not set" / status strings.
//
// This endpoint is intentionally open (no authentication required) but exposes
// only configuration status, not credential values.

// Read from env so sandbox (api-eval.signnow.com) and production (api.signnow.com)
// apps both work without a code change.
const SIGNNOW_API_BASE = process.env.SIGNNOW_API_BASE || "https://api.signnow.com";

function hasOAuthConfig() {
  return !!(
    process.env.SIGNNOW_CLIENT_ID &&
    process.env.SIGNNOW_CLIENT_SECRET &&
    process.env.SIGNNOW_EMAIL &&
    process.env.SIGNNOW_PASSWORD
  );
}

async function tryGetOAuthToken() {
  const { SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_EMAIL, SIGNNOW_PASSWORD } = process.env;
  const credentials = Buffer.from(`${SIGNNOW_CLIENT_ID}:${SIGNNOW_CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch(`${SIGNNOW_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: SIGNNOW_EMAIL,
      password: SIGNNOW_PASSWORD,
      scope: "*",
    }).toString(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return { ok: false, status: tokenRes.status, error: text };
  }
  const data = await tokenRes.json();
  return { ok: true, token: data.access_token };
}

async function tryGetDocument(token, templateId) {
  const docRes = await fetch(`${SIGNNOW_API_BASE}/document/${templateId}?type=fields`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!docRes.ok) {
    const text = await docRes.text();
    return { ok: false, status: docRes.status, error: text };
  }
  const data = await docRes.json();
  // Collect unique role names from the document's fields/roles
  const roles = [];
  if (Array.isArray(data.roles)) {
    data.roles.forEach(r => { if (r.name && !roles.includes(r.name)) roles.push(r.name); });
  }
  if (Array.isArray(data.fields)) {
    data.fields.forEach(f => { if (f.role_name && !roles.includes(f.role_name)) roles.push(f.role_name); });
  }
  return { ok: true, roles };
}

/**
 * Returns a human-readable hint for a failed OAuth token response.
 * The most common failure is "invalid_client" which happens when a sandbox/eval
 * application is used against the production API endpoint (or vice-versa).
 */
function oauthFailureHint(status, errorBody) {
  try {
    const parsed = typeof errorBody === "string" ? JSON.parse(errorBody) : errorBody;
    if (parsed && parsed.error === "invalid_client") {
      const current = process.env.SIGNNOW_API_BASE || "https://api.signnow.com (production, default)";
      const other = (process.env.SIGNNOW_API_BASE || "").includes("eval")
        ? "https://api.signnow.com"
        : "https://api-eval.signnow.com";
      return (
        `"invalid_client" means your Client ID/Secret are not recognised by this API endpoint. ` +
        `Current endpoint: ${current}. ` +
        `If you created your app in the SignNow sandbox/eval dashboard, add ` +
        `SIGNNOW_API_BASE = ${other} in Vercel → Settings → Environment Variables and redeploy. ` +
        `If you are using the production dashboard, double-check that SIGNNOW_CLIENT_ID and ` +
        `SIGNNOW_CLIENT_SECRET are copied correctly.`
      );
    }
  } catch (_) { /* not JSON — fall through */ }
  if (status === 401) return "Invalid credentials — check SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_EMAIL, and SIGNNOW_PASSWORD.";
  return "Unexpected error — check Vercel function logs for details.";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const report = {
    timestamp: new Date().toISOString(),
    apiBase: SIGNNOW_API_BASE,
    auth: {},
    templateId: {},
    template: null,
    roleName: {},
    overall: null,
  };

  // ── Authentication ──────────────────────────────────────────────────────────
  const templateId = process.env.SIGNNOW_TEMPLATE_ID || process.env.SIGNNOW_DOCUMENT_ID;
  const configuredRoleName = process.env.SIGNNOW_ROLE_NAME || "Signer 1";
  report.roleName = {
    value: configuredRoleName,
    source: process.env.SIGNNOW_ROLE_NAME ? "SIGNNOW_ROLE_NAME env var" : "default",
  };

  let token = null;
  if (hasOAuthConfig()) {
    report.auth.method = "oauth";
    report.auth.vars = {
      SIGNNOW_CLIENT_ID: "✅ set",
      SIGNNOW_CLIENT_SECRET: "✅ set",
      SIGNNOW_EMAIL: "✅ set",
      SIGNNOW_PASSWORD: "✅ set",
    };
    try {
      const result = await tryGetOAuthToken();
      if (result.ok) {
        token = result.token;
        report.auth.status = "✅ Token obtained successfully";
      } else {
        report.auth.status = `❌ Token request failed (HTTP ${result.status}): ${result.error}`;
        report.auth.hint = oauthFailureHint(result.status, result.error);
      }
    } catch (err) {
      report.auth.status = `❌ Token request threw: ${err.message}`;
    }
  } else if (process.env.SIGNNOW_API_TOKEN) {
    report.auth.method = "static_token";
    report.auth.vars = { SIGNNOW_API_TOKEN: "✅ set" };
    report.auth.status = "⚠️  Static token set — this token expires after ~30–60 minutes. Switch to OAuth credentials (SIGNNOW_CLIENT_ID + SIGNNOW_CLIENT_SECRET + SIGNNOW_EMAIL + SIGNNOW_PASSWORD) for long-term reliability.";
    token = process.env.SIGNNOW_API_TOKEN;
  } else {
    const missing = [];
    if (!process.env.SIGNNOW_CLIENT_ID) missing.push("SIGNNOW_CLIENT_ID");
    if (!process.env.SIGNNOW_CLIENT_SECRET) missing.push("SIGNNOW_CLIENT_SECRET");
    if (!process.env.SIGNNOW_EMAIL) missing.push("SIGNNOW_EMAIL");
    if (!process.env.SIGNNOW_PASSWORD) missing.push("SIGNNOW_PASSWORD");
    report.auth.method = "none";
    report.auth.status = `❌ No credentials set. Add either: OAuth vars (${missing.join(", ")}) OR SIGNNOW_API_TOKEN`;
  }

  // ── Template ID ─────────────────────────────────────────────────────────────
  if (templateId) {
    report.templateId.status = "✅ Set";
    report.templateId.source = process.env.SIGNNOW_TEMPLATE_ID
      ? "SIGNNOW_TEMPLATE_ID"
      : "SIGNNOW_DOCUMENT_ID (legacy)";
  } else {
    report.templateId.status = "❌ Not set — add SIGNNOW_TEMPLATE_ID in Vercel → Settings → Environment Variables";
  }

  // ── Template Access ─────────────────────────────────────────────────────────
  if (token && templateId) {
    try {
      const result = await tryGetDocument(token, templateId);
      if (result.ok) {
        const roleMatch = result.roles.includes(configuredRoleName);
        report.template = {
          status: "✅ Template accessible",
          roles: result.roles.length > 0 ? result.roles : ["(none found — template may have no roles defined)"],
          configuredRoleName,
          roleMatch: roleMatch
            ? `✅ "${configuredRoleName}" found in template roles`
            : `❌ "${configuredRoleName}" NOT found in template roles. Roles available: [${result.roles.join(", ")}]. Set SIGNNOW_ROLE_NAME to one of these values.`,
        };
      } else {
        report.template = {
          status: `❌ Template not accessible (HTTP ${result.status}): ${result.error}`,
          hint: result.status === 404
            ? "SIGNNOW_TEMPLATE_ID does not exist or is not accessible with this account."
            : result.status === 401
            ? "Token is invalid or expired. Regenerate or switch to OAuth credentials."
            : "Unexpected error — check Vercel function logs for details.",
        };
      }
    } catch (err) {
      report.template = { status: `❌ Template check threw: ${err.message}` };
    }
  } else if (!token) {
    report.template = { status: "⏭ Skipped (no token)" };
  } else {
    report.template = { status: "⏭ Skipped (no template ID)" };
  }

  // ── Overall ─────────────────────────────────────────────────────────────────
  const authOk = token !== null;
  const templateIdOk = !!templateId;
  const templateOk = report.template && report.template.status.startsWith("✅");
  const roleOk = templateOk && report.template.roleMatch && report.template.roleMatch.startsWith("✅");

  if (authOk && templateIdOk && templateOk && roleOk) {
    report.overall = "✅ All checks passed — SignNow is correctly configured";
  } else if (authOk && templateIdOk && templateOk && !roleOk) {
    report.overall = `⚠️  Almost ready — role name mismatch. Set SIGNNOW_ROLE_NAME to match a role in your template.`;
  } else if (!authOk) {
    report.overall = "❌ Authentication not configured — add SignNow credentials in Vercel → Settings → Environment Variables";
  } else if (!templateIdOk) {
    report.overall = "❌ SIGNNOW_TEMPLATE_ID not set — add it in Vercel → Settings → Environment Variables";
  } else {
    report.overall = "❌ Template not accessible — check the error above and Vercel function logs";
  }

  return res.status(200).json(report);
}
