// api/_github-retry.js
// Shared helper: retry a GitHub file read-modify-write cycle on 409 conflict.
//
// GitHub Contents API returns 409 (Conflict) when the SHA supplied in a PUT
// request is stale, i.e. another write has occurred between our GET and PUT.
// Rather than surfacing that as a user-visible error, we transparently re-load
// the current file state and re-apply the desired change, up to maxRetries times.

const DEFAULT_MAX_RETRIES = 8;   // High enough to outlast concurrent cron writes
const DEFAULT_BACKOFF_MS  = 250; // Increased for more spread between retries

/**
 * Returns true if the thrown error looks like a GitHub 409 SHA conflict.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function is409Conflict(err) {
  const msg = (err && err.message) ? String(err.message) : "";
  return /\b409\b/.test(msg) || /sha.*conflict|conflict.*sha/i.test(msg);
}

/**
 * Execute a read-modify-write cycle against a GitHub-backed JSON file and
 * automatically retry on 409 SHA-conflict errors.
 *
 * On each attempt the helper calls `load()` to get the current file state,
 * calls `apply(data)` to mutate it, then calls `save(data, sha, message)`.
 * If the save throws a 409, it backs off and tries again from the load step.
 *
 * The `apply` callback is called fresh on every attempt, so it **must be
 * idempotent** — if the same change has already been stored, apply should be
 * a no-op (e.g. check for an existing id before pushing to an array).
 *
 * @param {object}   opts
 * @param {() => Promise<{data: any, sha: string|null}>} opts.load
 *   Fetches the current file from GitHub. Called once per attempt.
 * @param {(data: any) => void} opts.apply
 *   Mutates `data` in place.  Must be idempotent across retries.
 * @param {(data: any, sha: string|null, message: string) => Promise<void>} opts.save
 *   Writes data back to GitHub using the sha returned by the last `load`.
 * @param {string}   opts.message   Commit message.
 * @param {number}  [opts.maxRetries=3]
 * @param {number}  [opts.backoffMs=150]
 *   Base delay (ms) between retries.  Actual delay is `backoffMs * attempt`
 *   plus a small random jitter to reduce thundering-herd collisions.
 * @returns {Promise<any>} Resolves with the mutated data on success.
 * @throws  Re-throws the last error when retries are exhausted or when the
 *          error is not a 409 conflict.
 */
export async function updateJsonFileWithRetry({
  load,
  apply,
  save,
  message,
  maxRetries = DEFAULT_MAX_RETRIES,
  backoffMs  = DEFAULT_BACKOFF_MS,
}) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { data, sha } = await load();
      apply(data);
      await save(data, sha, message);
      return data;
    } catch (err) {
      lastError = err;
      // Only retry on a 409 SHA conflict; any other error is terminal
      if (!is409Conflict(err) || attempt === maxRetries - 1) {
        throw err;
      }
      // Exponential back-off with jitter before re-fetching the latest SHA
      const delay = backoffMs * (attempt + 1) + Math.floor(Math.random() * 50);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
