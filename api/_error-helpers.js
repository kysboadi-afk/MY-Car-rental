// api/_error-helpers.js
// Shared helper for producing safe, diagnostic error messages for admin
// API endpoints.  Raw exception messages are logged server-side; only
// a sanitised, category-level description is returned to the client so
// that no internal implementation details (file paths, service names,
// raw API responses) are ever exposed.
//
// Error categories (in match priority order):
//   1. GitHub auth failure (401/403)
//   2. GitHub SHA conflict — 409 on file PUT (specific to GitHub write flows)
//   3. GitHub rate-limit (429)
//   4. Network / DNS errors
//   5. Supabase: missing table / column (migration not applied — PostgreSQL 42P01/42703)
//   6. Supabase: unique-constraint violation (PostgreSQL 23505)
//   7. Supabase/PostgREST: single() returned 0 or >1 rows (PGRST116)
//   8. Generic Supabase/PostgREST error (PGRST error code prefix)
//   9. GitHub generic failure
//  10. Fallback

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

  // ── GitHub authentication / authorisation failure ──────────────────────────
  if (/\b(401|403)\b/.test(raw) || /bad credentials|authentication|forbidden/i.test(raw)) {
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

/**
 * Given an error thrown by an OpenAI API call, return a human-readable
 * string suitable for displaying to an admin user.
 *
 * The fetch wrappers in admin-chat.js and admin-ai-assist.js always throw
 * errors in the form `"OpenAI API error NNN: {body}"` when the OpenAI HTTP
 * response is not 2xx.  This function extracts the numeric status code from
 * that pattern to drive categorisation; text-based heuristics are NOT used
 * so that the logic remains stable if OpenAI changes error message wording.
 *
 * If the error message does not contain the expected pattern (e.g. a network
 * timeout or a JSON parse error) the function falls through to a generic
 * message with a hint to check Vercel function logs.
 *
 * @param {unknown} err - the value caught by a catch block
 * @param {string} [model] - optional model name to include in error messages
 * @returns {string}
 */
export function openAIErrorMessage(err, model) {
  const raw = (err && err.message) ? String(err.message) : "";
  const modelHint = model ? ` (model: ${model})` : "";

  // Key not configured — surface as-is (no sensitive data in this message).
  if (raw.includes("OPENAI_API_KEY")) return raw;

  // SDK errors (openai package) expose a numeric `status` property directly.
  // Legacy fetch-based callers throw errors shaped "OpenAI API error NNN: …".
  const statusMatch = raw.match(/OpenAI API error (\d+)/);
  const status = (err && typeof err.status === "number") ? err.status
               : statusMatch ? Number(statusMatch[1]) : null;

  if (status === 401) {
    return "AI assistant error: The OpenAI API key is invalid or revoked. Please verify OPENAI_API_KEY in your Vercel environment settings.";
  }
  if (status === 429) {
    return "AI assistant error: OpenAI usage quota or rate limit exceeded. Please check your OpenAI account billing settings.";
  }
  if (status === 404) {
    return `AI assistant error: The configured AI model was not found${modelHint}. The model may have been deprecated — set the OPENAI_MODEL environment variable in your Vercel dashboard to a valid model (e.g. gpt-5-mini).`;
  }
  if (status === 500) {
    return `AI assistant error: OpenAI returned HTTP 500${modelHint} (server-side error). This is usually a transient issue — please try again in a moment. If it persists, check Vercel function logs for the full error detail.`;
  }
  if (status !== null) {
    return `AI assistant error: OpenAI returned HTTP ${status}${modelHint}. Check Vercel function logs for full details.`;
  }

  // No status code in the message — return a generic message with a hint.
  return "The AI assistant encountered an error. Please try again. If the problem persists, check Vercel function logs.";
}
