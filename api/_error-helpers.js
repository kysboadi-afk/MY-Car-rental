// api/_error-helpers.js
// Shared helper for producing safe, diagnostic error messages for admin
// API endpoints.  Raw exception messages are logged server-side; only
// a sanitised, category-level description is returned to the client so
// that no internal implementation details (file paths, service names,
// raw API responses) are ever exposed.
//
// Error categories (in match priority order):
//   1. Bouncie API authentication failure (BOUNCIE_ACCESS_TOKEN)
//   2. GitHub auth failure (401/403) — requires "github" in the error message
//   3. GitHub SHA conflict — 409 on file PUT (specific to GitHub write flows)
//   4. GitHub rate-limit (429)
//   5. Network / DNS errors
//   6. Supabase: missing table / column (migration not applied — PostgreSQL 42P01/42703)
//   7. Supabase: unique-constraint violation (PostgreSQL 23505)
//   8. Supabase/PostgREST: single() returned 0 or >1 rows (PGRST116)
//   9. Generic Supabase/PostgREST error (PGRST error code prefix)
//  10. GitHub generic failure
//  11. Fallback

/**
 * Returns true when the error is a Supabase/PostgreSQL "table or column not
 * found" error — indicating that Supabase migrations have not been applied yet.
 * Use this to decide whether to fall through to a GitHub-based fallback storage
 * path instead of surfacing a fatal error to the user.
 *
 * @param {unknown} err - the value caught by a catch block or a Supabase error object
 * @returns {boolean}
 */
export function isSchemaError(err) {
  if (!err) return false;
  const code = err.code ? String(err.code) : "";
  const msg  = err.message ? String(err.message) : "";
  return (
    code === "42P01" || code === "42703" ||
    code === "PGRST204" || code === "PGRST200" ||
    /relation .* does not exist/i.test(msg) ||
    /table .* (was )?not found/i.test(msg) ||
    /column .* does not exist/i.test(msg) ||
    /Could not find the .* in the schema cache/i.test(msg) ||
    /42P01|42703/.test(msg) // codes may also appear embedded in message text
  );
}

/**
 * Given a caught error, return a human-readable string suitable for
 * displaying to an admin user.  The message is informative enough to
 * guide diagnosis without leaking sensitive implementation details.
 *
 * @param {unknown} err - the value caught by a catch block
 * @returns {string}
 */
export function adminErrorMessage(err) {
  const raw  = (err && err.message) ? String(err.message) : "";
  // Supabase JS client exposes the PostgreSQL / PostgREST error code on err.code
  const code = (err && err.code)    ? String(err.code)    : "";

  // ── Bouncie API authentication failure ────────────────────────────────────
  // Must be checked before the generic 401/403 GitHub block because Bouncie
  // errors also contain status codes like "(401)" but are unrelated to GitHub.
  if (/bouncie/i.test(raw)) {
    return "Bouncie authentication failed — please verify that BOUNCIE_ACCESS_TOKEN is set correctly in your Vercel environment variables. Copy the access token from your Bouncie developer dashboard and add it as BOUNCIE_ACCESS_TOKEN in Vercel. No OAuth flow or redirect URI is required.";
  }

  // ── GitHub authentication / authorisation failure ──────────────────────────
  // Require "github" context to avoid false-positives from other 401/403 sources.
  if (
    (/\b(401|403)\b/.test(raw) || /bad credentials|forbidden/i.test(raw)) &&
    /github/i.test(raw)
  ) {
    return "Authentication failed — please verify that GITHUB_TOKEN is configured correctly and has write access to the repository.";
  }

  // ── Stale SHA / write conflict (GitHub-specific 409 on file PUT) ───────────
  // Use a narrow pattern to avoid matching PostgreSQL "conflict" messages.
  if (/\b409\b/.test(raw) || /sha.*conflict|conflict.*sha/i.test(raw)) {
    return "A concurrent update conflict occurred — please try again.";
  }

  // ── GitHub / API rate-limit ────────────────────────────────────────────────
  if (/\b429\b/.test(raw) || /rate.?limit/i.test(raw)) {
    return "API rate limit exceeded — please wait a moment and try again.";
  }

  // ── Network / DNS / connection errors ──────────────────────────────────────
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(raw)) {
    return "Could not reach the data store API — please check network connectivity and try again.";
  }

  // ── Supabase: table or column missing (migration not applied) ─────────────
  // PostgreSQL 42P01 = undefined_table, 42703 = undefined_column
  // PostgREST PGRST204 = "Could not find the relation X in the schema cache"
  // PostgREST PGRST200 = "Embedded resource not found in the schema cache"
  if (
    code === "42P01" || code === "42703" ||
    code === "PGRST204" || code === "PGRST200" ||
    /relation .* does not exist|table .* (was )?not found|column .* does not exist/i.test(raw) ||
    /Could not find the .* in the schema cache/i.test(raw) ||
    /42P01|42703/.test(raw)
  ) {
    return "Database schema error — a required table or column was not found. Please ensure all Supabase migrations have been applied (see SUPABASE_SETUP.md for setup instructions).";
  }

  // ── Supabase: NOT NULL constraint violation ────────────────────────────────
  // PostgreSQL 23502 = not_null_violation
  if (
    code === "23502" ||
    /23502|violates not-null constraint|null value in column .* violates not-null/i.test(raw)
  ) {
    return "A required field is missing a value — please ensure all fields have valid values before saving.";
  }

  // ── Supabase: unique-constraint violation ──────────────────────────────────
  // PostgreSQL 23505 = unique_violation
  if (
    code === "23505" ||
    /duplicate key value violates unique constraint|23505/i.test(raw)
  ) {
    return "A record with this key already exists — please refresh and try again, or check for duplicate entries.";
  }

  // ── Supabase/PostgREST: .single() returned 0 or multiple rows ─────────────
  // PGRST116 = "JSON object requested, multiple (or no) rows returned"
  if (
    code === "PGRST116" ||
    /PGRST116|JSON object requested, multiple|no rows returned/i.test(raw)
  ) {
    return "The record was not found after saving — please refresh and try again.";
  }

  // ── Generic Supabase / PostgREST error ─────────────────────────────────────
  if (/^PGRST/i.test(code) || /PGRST[0-9]+/i.test(raw)) {
    return "Database operation failed — please try again. If the problem persists, check the server logs for details.";
  }

  // ── Any other identifiable GitHub data-store failure ──────────────────────
  if (/GitHub/i.test(raw)) {
    return "Data store request failed — please try again. If the problem persists, check the server logs for details.";
  }

  // ── Fallback ────────────────────────────────────────────────────────────────
  return "An unexpected error occurred — please try again. If the problem persists, check the server logs for details.";
}

