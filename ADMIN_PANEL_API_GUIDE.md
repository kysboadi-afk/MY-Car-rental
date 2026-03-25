# Admin Panel API Guide

> Last updated: 2026-03 | Backend: Vercel serverless functions | DB: Supabase + GitHub JSON

---

## Overview

The SLYTRANS Fleet Control admin panel (`/public/admin-v2/`) communicates exclusively with Vercel
serverless functions under `/api/v2-*`. All endpoints use `POST` and require the `ADMIN_SECRET`
environment variable in the request body.

---

## Endpoint Reference

### Authentication

Every `POST` body must include:

```json
{ "secret": "<ADMIN_SECRET>" }
```

Responses on auth failure: `401 Unauthorized`.  
Responses on server misconfiguration: `500` with a descriptive message.

---

### `/api/v2-bookings`

Data source: `bookings.json` (GitHub file via GitHub API)

| Action   | Required fields                                   | Returns                    |
|----------|---------------------------------------------------|----------------------------|
| `list`   | _(none)_ — optional: `vehicleId`, `status`       | `{ bookings: [...] }`      |
| `update` | `vehicleId`, `bookingId`, `updates`               | `{ success, booking }`     |
| `create` | `vehicleId`, `name`, `pickupDate`, `returnDate`   | `{ success, booking }`     |

**Empty state**: `list` always returns `{ bookings: [] }` when no bookings exist — never crashes.

**Booking automation** (triggered automatically on update/create):

When a booking status transitions to `booked_paid` or `active_rental`:
1. A revenue record is auto-created in Supabase `revenue_records` (idempotent — duplicates skipped).
2. The customer is auto-upserted in Supabase `customers` (keyed by phone number).

When a booking transitions to `completed_rental`:
- Customer stats are updated (total_bookings, total_spent, last_booking_date).

These operations are **non-fatal**: if Supabase is unavailable the booking update still succeeds;
errors are logged server-side.

---

### `/api/v2-revenue`

Data source: Supabase `revenue_records` table

| Action    | Required fields                              | Returns                         |
|-----------|----------------------------------------------|---------------------------------|
| `list`    | _(none)_ — optional: `vehicleId`, `status`, `startDate`, `endDate` | `{ records: [...] }` |
| `get`     | `id`                                         | `{ record }`                    |
| `create`  | `booking_id`, `vehicle_id`, `gross_amount`   | `{ record }` (201)              |
| `update`  | `id`, `updates`                              | `{ record }`                    |
| `delete`  | `id`                                         | `{ success: true }`             |
| `summary` | _(none)_                                     | `{ summary: [...] }`            |

**Empty state**: `list` and `summary` return `{ records: [] }` / `{ summary: [] }` when Supabase is
not configured or the table does not exist — the Revenue page loads with an empty table.

**Refund handling**: Set `refund_amount` on the revenue record via the `update` action. The
`net_amount` column in Supabase is a generated column (`gross_amount - refund_amount`) and the
`vehicle_revenue_summary` view automatically reflects the net after refund.

---

### `/api/v2-customers`

Data source: Supabase `customers` table (keyed by phone number)

| Action   | Required fields                     | Returns                   |
|----------|-------------------------------------|---------------------------|
| `list`   | _(none)_ — optional: `search`, `banned`, `flagged` | `{ customers: [...] }` |
| `get`    | `id`                                | `{ customer }`            |
| `upsert` | `name`, `phone`                     | `{ customer }`            |
| `update` | `id`, `updates`                     | `{ customer }`            |
| `sync`   | _(none)_                            | `{ synced, message }`     |

**Empty state**: `list` returns `{ customers: [] }` when Supabase is not configured or the table
is missing. The Customers page loads with an empty table and a "Sync" button.

**Sync**: The `sync` action rebuilds the `customers` table from all bookings in `bookings.json`,
grouping by phone number and aggregating `total_bookings`, `total_spent`, `first_booking_date`,
and `last_booking_date`.

---

### `/api/v2-system-settings`

Data source: Supabase `system_settings` table

| Action   | Required fields   | Returns                    |
|----------|-------------------|----------------------------|
| `list`   | _(none)_          | `{ settings: [...] }`      |
| `get`    | `key`             | `{ setting }`              |
| `set`    | `key`, `value`    | `{ setting }`              |
| `delete` | `key`             | `{ success: true }`        |

**Empty state / defaults**: When Supabase is not configured, `list` returns the hardcoded
`DEFAULT_SETTINGS` array so the System Settings page is immediately usable. When the table exists
but is empty (e.g., after a fresh Supabase project without migrations), the defaults are
automatically seeded on the first `list` call.

**Default settings** (category → key → default value):

| Category     | Key                            | Default  |
|--------------|-------------------------------|---------|
| pricing      | slingshot_daily_rate           | 350      |
| pricing      | camry_daily_rate               | 55       |
| pricing      | camry_weekly_rate              | 350      |
| pricing      | camry_biweekly_rate            | 650      |
| pricing      | camry_monthly_rate             | 1300     |
| pricing      | slingshot_security_deposit     | 150      |
| pricing      | slingshot_booking_deposit      | 50       |
| tax          | la_tax_rate                    | 0.1025   |
| automation   | auto_block_dates_on_approve    | true     |
| automation   | auto_create_revenue_on_pay     | true     |
| automation   | auto_update_customer_stats     | true     |
| automation   | overdue_grace_period_hours     | 2        |
| notification | notify_sms_on_approve          | true     |
| notification | notify_email_on_approve        | true     |

---

### `/api/v2-protection-plans`

Data source: Supabase `protection_plans` table

| Action   | Required fields                 | Returns            |
|----------|---------------------------------|--------------------|
| `list`   | _(none)_                        | `{ plans: [...] }` |
| `get`    | `id`                            | `{ plan }`         |
| `create` | `name`, `daily_rate`            | `{ plan }` (201)   |
| `update` | `id`, `updates`                 | `{ plan }`         |
| `delete` | `id`                            | `{ success }`      |

**Empty state**: `list` returns `{ plans: [] }` when Supabase is unavailable.

---

## Error Contract

All endpoints follow a consistent error contract:

| Scenario                               | HTTP Status | Body                                  |
|----------------------------------------|-------------|---------------------------------------|
| Missing `ADMIN_SECRET`                 | 500         | `{ error: "ADMIN_SECRET not configured" }` |
| Wrong `secret`                         | 401         | `{ error: "Unauthorized" }`           |
| Supabase not configured (READ)         | 200         | empty state (e.g. `{ records: [] }`)  |
| Supabase not configured (WRITE)        | 503         | `{ error: "Supabase not configured…" }` |
| DB table missing (READ)                | 200         | empty state + server-side log         |
| Validation error                       | 400         | `{ error: "<field> is required" }`    |
| Not found                              | 404         | `{ error: "… not found" }`            |
| Conflict (date overlap)                | 409         | `{ error: "Date conflict: …" }`       |
| Internal / unexpected                  | 500         | `{ error: "An unexpected error…" }`   |

**Key principle**: READ operations (list, get, summary) never return 5xx due to Supabase being
unavailable — they degrade gracefully to empty state so the admin panel always loads.

---

## Database Tables

Created by `supabase/migrations/0003_admin_control_system.sql`:

| Table                    | Purpose                                           |
|--------------------------|---------------------------------------------------|
| `revenue_records`        | One row per booking payment / refund event        |
| `payment_transactions`   | Granular transaction ledger (charge, refund, …)   |
| `customers`              | Customer profiles aggregated from bookings        |
| `system_settings`        | Admin-controlled key/value config                 |
| `protection_plans`       | Coverage plan tiers                               |
| `booking_status_history` | Audit trail for status changes                    |

View:
- `vehicle_revenue_summary` — per-vehicle aggregated revenue (auto-updated by DB)

---

## Sample Data

Seeded via `supabase/migrations/0004_sample_data.sql` and `bookings.json`:

| Customer         | Vehicle       | Days | Gross   | Refund | Net     |
|------------------|---------------|------|---------|--------|---------|
| David Agbebaku   | Camry 2013 SE | 7    | $479.59 | –      | $479.59 |
| Mariatu Sillah   | Camry 2012    | 4    | $200.00 | –      | $200.00 |
| Bernard Gilot    | Camry 2012    | 11   | $785.00 | $300   | $485.00 |

**Fleet revenue totals** (reflected in `vehicle_revenue_summary`):
- `camry2013` → $479.59 net
- `camry` → $685.00 net ($200 + $485)
- Combined → $1,164.59 net

---

## Applying Migrations

Run migrations in order against your Supabase project:

```bash
# Using Supabase CLI
supabase db push

# Or manually via the Supabase SQL editor:
# 1. 0001_create_vehicles.sql
# 2. 0002_seed_fleet_vehicles.sql
# 3. 0003_admin_control_system.sql   ← creates all admin tables
# 4. 0004_sample_data.sql            ← seeds sample bookings
```

See `SUPABASE_SETUP.md` for full configuration instructions.
