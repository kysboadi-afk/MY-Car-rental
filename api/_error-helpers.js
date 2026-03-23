// api/_error-helpers.js
// Shared helper for producing safe, diagnostic error messages for admin
// API endpoints.  Raw exception messages are logged server-side; only
// a sanitised, category-level description is returned to the client so
// that no internal implementation details (file paths, service names,
// raw API responses) are ever exposed.

/**
 * Given a caught error, return a human-readable string suitable for
 * displaying to an admin user.  The message is informative enough to
 * guide diagnosis without leaking sensitive implementation details.
 *
 * @param {unknown} err - the value caught by a catch block
 * @returns {string}
 */
export function adminErrorMessage(err) {
  const raw = (err && err.message) ? String(err.message) : "";

  // GitHub authentication / authorisation failure
  if (/\b(401|403)\b/.test(raw) || /bad credentials|authentication|forbidden/i.test(raw)) {
    return "Authentication failed — please verify that GITHUB_TOKEN is configured correctly and has write access to the repository.";
  }

  // Stale SHA / write conflict (two concurrent saves)
  if (/\b409\b/.test(raw) || /sha|conflict/i.test(raw)) {
    return "A concurrent update conflict occurred — please try again.";
  }

  // GitHub API rate-limit
  if (/\b429\b/.test(raw) || /rate.?limit/i.test(raw)) {
    return "API rate limit exceeded — please wait a moment and try again.";
  }

  // Network / DNS / connection errors
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(raw)) {
    return "Could not reach the data store API — please check network connectivity and try again.";
  }

  // Any other identifiable data-store failure
  if (/GitHub/i.test(raw)) {
    return "Data store request failed — please try again. If the problem persists, check the server logs for details.";
  }

  // Fallback
  return "An unexpected error occurred — please try again. If the problem persists, check the server logs for details.";
}
