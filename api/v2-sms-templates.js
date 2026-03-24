// api/v2-sms-templates.js
// SLYTRANS FLEET CONTROL v2 — SMS templates CRUD endpoint.
// Returns all SMS templates (from hardcoded defaults + any DB overrides stored
// in sms-templates.json) and allows admins to edit/enable/disable templates.
//
// POST /api/v2-sms-templates
// Actions:
//   list   — { secret, action:"list" }
//   update — { secret, action:"update", templateKey, updates:{message?, enabled?} }
//   reset  — { secret, action:"reset", templateKey }

import { TEMPLATES } from "./_sms-templates.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS   = ["https://www.slytrans.com", "https://slytrans.com"];
const GITHUB_REPO       = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const TEMPLATES_DB_PATH = "sms-templates.json";

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Load overrides from sms-templates.json (returns empty object if missing). */
async function loadOverrides() {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${TEMPLATES_DB_PATH}`;
  const resp    = await fetch(apiUrl, { headers: ghHeaders() });
  if (!resp.ok) {
    if (resp.status === 404) return { data: {}, sha: null };
    return { data: {}, sha: null }; // non-fatal — proceed with defaults
  }
  const file = await resp.json();
  let data = {};
  try {
    data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch {
    data = {};
  }
  return { data, sha: file.sha };
}

/** Save overrides to sms-templates.json. */
async function saveOverrides(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("v2-sms-templates: GITHUB_TOKEN not set — overrides will not be saved");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${TEMPLATES_DB_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content };
  if (sha) body.sha = sha;

  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT sms-templates.json failed: ${resp.status} ${text}`);
  }
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

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body   = req.body || {};
  const { secret, action } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { data: overrides, sha } = await loadOverrides();

    // ── LIST ────────────────────────────────────────────────────────────────
    if (action === "list" || !action) {
      const result = Object.entries(TEMPLATES).map(([key, defaultMessage]) => {
        const override = overrides[key] || {};
        return {
          key,
          message:         override.message ?? defaultMessage,
          defaultMessage,
          enabled:         override.enabled ?? true,
          isCustomized:    Object.prototype.hasOwnProperty.call(overrides, key),
          triggerEvent:    key.split("_").slice(0, 2).join("_"),
        };
      });
      return res.status(200).json({ templates: result });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      const { templateKey, updates } = body;

      if (!templateKey || typeof templateKey !== "string") {
        return res.status(400).json({ error: "templateKey is required" });
      }
      if (!Object.prototype.hasOwnProperty.call(TEMPLATES, templateKey)) {
        return res.status(400).json({ error: `Unknown template key: ${templateKey}` });
      }
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ error: "updates object is required" });
      }

      if (!overrides[templateKey]) overrides[templateKey] = {};

      if (typeof updates.message === "string") {
        overrides[templateKey].message = updates.message.slice(0, 1000);
      }
      if (typeof updates.enabled === "boolean") {
        overrides[templateKey].enabled = updates.enabled;
      }
      overrides[templateKey].updatedAt = new Date().toISOString();

      await saveOverrides(overrides, sha, `v2: Update SMS template ${templateKey}`);

      return res.status(200).json({
        success: true,
        template: {
          key:          templateKey,
          message:      overrides[templateKey].message ?? TEMPLATES[templateKey],
          enabled:      overrides[templateKey].enabled ?? true,
          isCustomized: true,
        },
      });
    }

    // ── RESET ───────────────────────────────────────────────────────────────
    if (action === "reset") {
      const { templateKey } = body;

      if (!templateKey || !Object.prototype.hasOwnProperty.call(TEMPLATES, templateKey)) {
        return res.status(400).json({ error: "Invalid templateKey" });
      }

      delete overrides[templateKey];
      await saveOverrides(overrides, sha, `v2: Reset SMS template ${templateKey} to default`);

      return res.status(200).json({
        success: true,
        template: {
          key:          templateKey,
          message:      TEMPLATES[templateKey],
          enabled:      true,
          isCustomized: false,
        },
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-sms-templates error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
