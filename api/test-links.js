// api/test-links.js
// Internal admin endpoint: validate all critical link types used in SMS messages.
//
// This endpoint is intended for operators to verify that all customer-facing
// URLs resolve correctly before a deployment or after a domain change.
//
// Authentication: requests must supply X-Admin-Key matching ADMIN_SECRET env var.
// If ADMIN_SECRET is not set the endpoint is disabled (returns 403) so it is
// never accidentally exposed in production without credentials.
//
// POST /api/test-links
// Response: { ok: boolean, results: Array<{name, url, ok, status, fallbackUsed}> }
//
// CORS: same allowlist as every other API endpoint (www.slytrans.com only).

import { validateLink, PAGE_URLS, BASE_URL } from "./_link-validator.js";

export const config = {
  api: { bodyParser: false },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/** Link catalogue — every URL type that can appear in a customer-facing SMS. */
const LINK_CATALOGUE = [
  {
    name: "Payment / extension page (balance.html)",
    url:  PAGE_URLS.balance,
  },
  {
    name: "Car listings page (cars.html)",
    url:  PAGE_URLS.cars,
  },
  {
    name: "Manage booking page (manage-booking.html)",
    url:  PAGE_URLS.managebooking,
  },
  {
    name: "Homepage (index.html)",
    url:  `${BASE_URL}/index.html`,
  },
  {
    name: "Homepage (root /)",
    url:  BASE_URL,
  },
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // Admin key guard — endpoint is disabled when ADMIN_SECRET is not set.
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.warn("test-links: ADMIN_SECRET not configured — endpoint disabled");
    return res.status(403).json({ error: "Endpoint not enabled" });
  }
  const providedKey = req.headers["x-admin-key"] || "";
  if (providedKey !== adminSecret) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Validate every link in the catalogue concurrently.
  const results = await Promise.all(
    LINK_CATALOGUE.map(async ({ name, url }) => {
      const r = await validateLink(url);
      return {
        name,
        url,
        ok:           r.ok,
        status:       r.status,
        fallbackUsed: r.fallbackUsed,
        resolvedUrl:  r.url,
      };
    })
  );

  const allOk = results.every((r) => r.ok);

  console.log(`test-links: checked ${results.length} links — ${results.filter((r) => r.ok).length} ok, ${results.filter((r) => !r.ok).length} failed`);

  return res.status(allOk ? 200 : 502).json({
    ok:        allOk,
    checkedAt: new Date().toISOString(),
    results,
  });
}
