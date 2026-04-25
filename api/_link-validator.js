// api/_link-validator.js
// Helper: validate a URL before including it in a customer-facing SMS.
//
// Uses a HEAD request (falling back to GET when HEAD returns 405 or errors)
// to check the page is reachable.  If the primary URL fails, the caller
// receives the configured fallback URL so the SMS is still useful.
//
// Design notes:
//   • Only the BASE page URL is validated (no query-string parameters).
//     Stripe client_secrets in query strings cannot be verified server-side;
//     the page itself just needs to load.
//   • Validation is best-effort and non-blocking: if a network error occurs
//     the function returns {ok: false} — the caller decides whether to send
//     the original URL, the fallback, or to abort.
//   • Timeout is intentionally short (4 s) so a slow GitHub Pages CDN edge
//     never blocks an outgoing SMS for more than a few seconds.
//   • Results are logged at console level so Vercel logs retain an audit trail.
//
// Usage:
//   import { validateLink, BASE_URL } from "./_link-validator.js";
//   const result = await validateLink("https://www.slytrans.com/balance.html");
//   // result: { ok: true, status: 200, url: "https://…/balance.html", fallbackUsed: false }
//
//   const payment = buildPaymentLink(pi.client_secret, pi.id);
//   const { url: safeUrl, ...validationMeta } = await validateLink(payment, {
//     baseUrlForValidation: "https://www.slytrans.com/balance.html",
//     fallback: "https://www.slytrans.com/cars.html",
//   });
//   // safeUrl is payment link when page is reachable, fallback when not

export const BASE_URL = "https://www.slytrans.com";

// Page URLs used as validation targets and SMS fallbacks.
export const PAGE_URLS = {
  balance:       `${BASE_URL}/balance.html`,
  cars:          `${BASE_URL}/cars.html`,
  managebooking: `${BASE_URL}/manage-booking.html`,
};

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_FALLBACK   = PAGE_URLS.cars;

/**
 * Validate a URL by performing a HEAD request (falls back to GET on 405).
 *
 * @param {string} url                       - Full URL to send in the SMS.
 * @param {object} [opts]
 * @param {string} [opts.baseUrlForValidation] - If provided, validate THIS URL
 *   instead of `url` (useful for long Stripe URLs — we validate the base page).
 *   The returned `url` field still contains the original full URL when the
 *   page is reachable.
 * @param {string} [opts.fallback]            - URL to return when validation fails.
 *   Defaults to https://www.slytrans.com/cars.html
 * @param {number} [opts.timeoutMs]           - Request timeout in ms. Default 4000.
 * @returns {Promise<{
 *   ok:           boolean,
 *   status:       number|null,
 *   url:          string,
 *   fallbackUsed: boolean,
 * }>}
 */
export async function validateLink(url, opts = {}) {
  const {
    baseUrlForValidation = null,
    fallback             = DEFAULT_FALLBACK,
    timeoutMs            = DEFAULT_TIMEOUT_MS,
  } = opts;

  const targetUrl  = baseUrlForValidation || url;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  let status = null;
  let ok     = false;

  try {
    // First attempt: HEAD (cheaper, no body transfer)
    let resp;
    let headNetworkError = false;
    try {
      resp = await fetch(targetUrl, {
        method:  "HEAD",
        signal:  controller.signal,
        headers: { "User-Agent": "SLY-RIDES-LinkValidator/1.0" },
      });
      status = resp.status;
    } catch (headErr) {
      // Network-level error on HEAD (DNS failure, timeout, connection refused, etc.).
      // Unlike an HTTP 405 response (which means the server is up but doesn't support HEAD),
      // a network error means the server is unreachable — retrying with GET would also fail
      // and waste time, so we fall straight through to the fallback.
      headNetworkError = true;
      console.warn(`_link-validator: HEAD network error for ${targetUrl}: ${headErr.message}`);
    }

    // 405 Method Not Allowed: server doesn't support HEAD; retry with GET
    if (!headNetworkError && status === 405) {
      const getResp = await fetch(targetUrl, {
        method:  "GET",
        signal:  controller.signal,
        headers: { "User-Agent": "SLY-RIDES-LinkValidator/1.0" },
      });
      status = getResp.status;
    }

    if (!headNetworkError) {
      ok = status !== null && status >= 200 && status < 400;
    }
  } catch (err) {
    // Outer catch: handles errors from the GET retry on 405, or any other unexpected error.
    console.warn(`_link-validator: fetch error for ${targetUrl}: ${err.message}`);
    ok     = false;
    status = null;
  } finally {
    clearTimeout(timer);
  }

  const result = {
    ok,
    status,
    url:          ok ? url : fallback,
    fallbackUsed: !ok,
  };

  console.log(
    `_link-validator: ${ok ? "✅" : "❌"} ${targetUrl} → HTTP ${status ?? "err"}` +
    (result.fallbackUsed ? ` (fallback: ${fallback})` : "")
  );

  return result;
}
