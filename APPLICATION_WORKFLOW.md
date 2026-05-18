# Renter Application Lifecycle (Production Workflow)

This defines the intended production state machine for renter applications, including Veriff and Checkr orchestration and admin recovery actions.

## 1) State Model

### Application status (`application_status`)
- `submitted`
- `under_review`
- `needs_info`
- `approved` (terminal)
- `rejected` (terminal)
- `withdrawn` (terminal archive/removal)
- `expired` (terminal)

### Identity status (`identity_status`)
- `not_started`
- `requires_input`
- `processing`
- `verified`
- `failed`
- `canceled`

### Checkr status (`checkr_report_status`)
- `not_started`
- `launch_queued`
- `candidate_created`
- `invitation_sent`
- `pending`
- `completed`
- `clear`
- `consider`
- `suspended`
- `failed`
- `webhook_missing`

---

## 2) Intended Lifecycle (happy path)

`Application Submitted`
→ `Verification Started` (`identity_status=requires_input`, app still actionable)
→ `Verification Pending` (`identity_status=processing`, app may be moved to `under_review`)
→ `Identity Approved` (`identity_status=verified`, app becomes `under_review` if still `submitted`)
→ `Under Review`
→ `Checkr Initiated` (`checkr_report_status=pending`)
→ `Background Pending`
→ Final decision: `approved` or `rejected` or `needs_info`

`submitted` is **not terminal** and remains actionable/recoverable.

---

## 3) Transition Rules

### Application status transitions
- `submitted` → `under_review`:
  - on identity verified/processing sync
  - or explicit admin move-to-review action
- `submitted|under_review|needs_info` → `approved|rejected|needs_info`:
  - via admin review action endpoint (concurrency-safe)
- `submitted|under_review|needs_info` → `withdrawn`:
  - via admin archive/delete action (queue cleanup, non-destructive to audit intent)
- terminal (`approved|rejected|withdrawn|expired`) do not transition back automatically

### Identity transitions
- `not_started` → `requires_input`: verification session created
- `requires_input` → `processing`: verification submitted
- `processing` → `verified|failed|canceled`: Veriff decision
- recovery sync can re-map stale/missed webhook states into `processing` or `verified`

### Checkr transitions
- starts only after identity is `verified`, required consent exists, and license data is present
- initial launch phases progress `launch_queued` → `candidate_created` → `invitation_sent`
- webhook/processing phases then update to `pending|completed|clear|consider|suspended|failed|webhook_missing`

---

## 4) Veriff + Checkr Orchestration

### When Checkr starts
- Automatically after Veriff webhook marks identity as verified (best-effort trigger)
- Can be retried manually from admin operation (`retry_checkr`)

### What blocks approval
- Business decision: reviewer should not approve while required verification/screening is incomplete
- System-level block exists for Checkr initiation unless:
  - `identity_status=verified`
  - background-check consent is true
  - driver license number/state are present

### What requires manual review
- `checkr_report_status=consider`
- identity issues (`failed`, `canceled`, repeated `requires_input`)
- any mismatch between identity outcome and current app state

### Incomplete verification
- stays actionable (`submitted`/`under_review`) and can be:
  - resent verification
  - restarted verification
  - manually recovered from Veriff decision lookup

### Expired sessions
- restart verification creates a fresh Veriff session and updates `identity_session_id`

### Resubmissions
- handled by restart verification and recovery flow; app record remains same, preserving continuity

---

## 5) Pending / Failure / Terminal Semantics

### Pending states
- identity: `requires_input`, `processing`
- screening: `launch_queued`, `candidate_created`, `invitation_sent`, `pending`, `suspended`
- application: `submitted`, `under_review`, `needs_info`

### Failure states
- identity: `failed`, `canceled`
- checkr: `failed`, `webhook_missing`
- these are recoverable/admin-actionable unless app is terminal

### Terminal states
- `approved`, `rejected`, `withdrawn`, `expired`
- no automated recovery paths should reopen these

---

## 6) Operational Admin Actions (required)

The admin operation endpoint supports:
- resend verification
- restart verification
- move to review
- request additional info
- manual recovery trigger
- retry Checkr initiation
- archive/delete (withdraw) single application
- archive test/debug queue rows (bulk cleanup with dry-run)

Queue UI includes explicit:
- **View** button
- **Delete** button (archive behavior)

---

## 7) Queue Reset Guidance

For environment reset without unsafe hard deletes:
1. Run dry-run archive of test/debug apps
2. Confirm and archive matches to `withdrawn`
3. Keep audit trail intent via operation logs/history
4. Execute one clean end-to-end production-like test application
