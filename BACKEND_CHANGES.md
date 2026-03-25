# SLY-RIDES Admin Portal — Backend Changes & Error Contract

## Overview

This document describes all endpoint changes, error contracts, and operational notes introduced as part of the comprehensive admin portal backend audit and repair.

---

## Changed Files

### `api/_error-helpers.js`
**What changed:** Error message mapping is now more precise and includes Supabase / PostgreSQL error codes.

| Error Class | Detection | User-Facing Message |
|---|---|---|
| GitHub auth failure | HTTP 401/403, "bad credentials" | Authentication failed — verify GITHUB_TOKEN |
| GitHub SHA conflict | HTTP 409, "sha…conflict" (narrow match) | A concurrent update conflict occurred — please try again |
| GitHub rate-limit | HTTP 429, "rate limit" | API rate limit exceeded — please wait |
| Network failure | ECONNREFUSED, ETIMEDOUT, fetch failed | Could not reach the data store API |
| DB table missing | PostgreSQL code `42P01` / `42703`, "relation does not exist" | Database schema error — apply migrations first |
| Unique constraint | PostgreSQL code `23505`, "duplicate key" | A record with this key already exists |
| PostgREST `.single()` failure | PGRST116, "JSON object requested" | The record was not found after saving — refresh and try again |
| Generic Supabase error | `PGRST*` code prefix | Database operation failed |
| GitHub generic error | "GitHub" in message | Data store request failed |
| Fallback | anything else | An unexpected error occurred |

**Why it matters:** Before this change, any Supabase/PostgreSQL error that didn't match the old patterns (which only detected GitHub SHA and 409) returned "unexpected error". Now all database-level failures produce a diagnostic, actionable message.

---

### `api/_github-retry.js`
**What changed:**
- `DEFAULT_MAX_RETRIES`: **3 → 5** (reduces user-visible "concurrent update conflict" on busy repositories)
- `DEFAULT_BACKOFF_MS`: **150 ms → 200 ms** (more spread between retries to reduce thundering-herd collisions)

**Effect on Vercel cold-start budget:** Worst-case additional delay from retries alone is ~2 seconds (4 inter-attempt delays of 200 ms × 1-4 × multiplier + jitter ≈ 200+400+600+800 = 2000 ms). Including network round-trips (5 attempts × ~100–500 ms each), total wall-clock time is approximately 3–5 seconds in the absolute worst case — well within Vercel's 10-second serverless timeout.

---

### `api/v2-customers.js` — `sync` action
**What changed:** Customer sync now handles bookings with empty or missing phone numbers.

**Before:** Bookings without a phone were silently skipped (no customers created for them).

**After:**
- Bookings **with** phone → grouped and batch-upserted by phone (unchanged, conflict-safe).
- Bookings **without** phone → grouped by lowercased name as a fallback key. Each is check-then-inserted (finds existing `name + phone IS NULL` row, updates it; otherwise inserts a new row with `phone = NULL`).

**Why it matters:** All three sample bookings in the repository had empty phone fields, causing "Sync from Bookings" to produce 0 customers. After this fix, sync creates customer records for all bookings regardless of whether a phone number is present.

---

### `api/v2-system-settings.js` — `set` action
**What changed:** The `upsert().select().single()` call now handles the rare case where PostgREST returns PGRST116 (0 or multiple rows from `.single()`) even after a successful upsert. A re-fetch is attempted before throwing.

**Error contract:**
- `200 OK` + `{ setting }` → write succeeded.
- `400 Bad Request` → `key` or `value` missing.
- `503 Service Unavailable` → Supabase is not configured (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` missing).
- `500 Internal Server Error` → write failed; message will now describe the root cause (migration missing, constraint violation, etc.) rather than the generic "unexpected error".

---

### `api/v2-revenue.js` — `summary` action
**What changed:** The `summary` response now always includes a `totals` object with cross-vehicle aggregates.

**New response shape:**
```json
{
  "summary": [ ...per-vehicle rows... ],
  "totals": {
    "gross": 1464.59,
    "refunds": 300.00,
    "net": 1164.59,
    "deposits": 0,
    "bookingCount": 3
  }
}
```

The `totals` object is pre-aggregated from the view rows (or from the manual fallback aggregation), eliminating a client-side reduce pass and ensuring the Revenue Tracker KPI cards always show correct cross-fleet figures.

---

## Database Migrations

### `supabase/migrations/0005_fixes.sql` *(new)*

Run this after `0004_sample_data.sql`. It is idempotent (safe to re-run).

| Step | Action |
|---|---|
| 1 | Deduplicate `revenue_records` — keeps oldest row per `booking_id` |
| 2 | Add `UNIQUE (booking_id)` constraint to `revenue_records` |
| 3 | Update sample customers with phone / email (matches updated `bookings.json`) |
| 4 | Update sample revenue records with customer phone / email |
| 5 | Re-seed missing sample revenue records (idempotent via new unique constraint) |
| 6 | Re-seed missing sample customers (idempotent via phone unique index) |

### `bookings.json` *(updated)*
Sample bookings now include realistic placeholder phone numbers and email addresses:

| Customer | Phone | Email |
|---|---|---|
| David Agbebaku | +12135550101 | d.agbebaku@example.com |
| Mariatu Sillah | +12135550102 | m.sillah@example.com |
| Bernard Gilot | +12135550103 | b.gilot@example.com |

This allows "Sync from Bookings" in Customer Management to work immediately after the repository is deployed, without requiring any additional data entry.

---

## Error Contract Summary

All admin API endpoints (`/api/v2-*`) follow this contract:

| HTTP Status | Meaning |
|---|---|
| `200 OK` | Operation succeeded; response body contains the requested data |
| `400 Bad Request` | Missing or invalid required fields; `error` field describes the problem |
| `401 Unauthorized` | `ADMIN_SECRET` missing or incorrect |
| `404 Not Found` | Requested resource (booking, customer, etc.) does not exist |
| `405 Method Not Allowed` | Only `POST` (and `OPTIONS`) are accepted |
| `409 Conflict` | Duplicate booking dates or other domain constraint |
| `500 Internal Server Error` | Server-side failure; `error` field contains a safe diagnostic message |
| `503 Service Unavailable` | Supabase is not configured (write operations only); `error` field explains the missing variable |

**READ operations** (`list`, `get`, `summary`) never return 5xx due to Supabase being unavailable — they degrade gracefully to empty arrays / defaults so the admin panel always loads.

**WRITE operations** (`create`, `update`, `delete`, `set`, `sync`) return `503` when Supabase is not configured and `500` when a database error occurs.

---

## How to Apply Migrations

1. Open your [Supabase Dashboard](https://app.supabase.com) → **SQL Editor**.
2. Paste the contents of each migration in order: `0001`, `0002`, `0003`, `0004`, `0005`.
3. Run each migration. They are all idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, etc.).

---

## Where to Find Backend Logs

| Platform | Location |
|---|---|
| **Vercel** | Dashboard → Project → **Functions** tab → click any function → **Logs** |
| **Local dev** | `npm run dev` (uses Vercel CLI) or run individual functions with Node.js and check stdout |
| **Supabase** | Dashboard → **Logs** → **PostgREST** or **Database** for query-level errors |

Server-side errors always log the full raw error message via `console.error(...)` before returning the sanitised message to the client. Search for `"v2-revenue error"`, `"v2-customers error"`, `"v2-system-settings error"`, or `"v2-bookings error"` to locate relevant log entries quickly.
