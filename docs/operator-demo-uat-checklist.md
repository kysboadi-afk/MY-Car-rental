# Operator Demo Scheduling UAT Checklist (Phase 1 Gate)

## 1) End-to-end onboarding lifecycle validation
- [ ] Submit a new Fleet Control lead and confirm lifecycle starts at `lead_submitted`.
- [ ] Trigger notification path and confirm transition to `notification_sent` with `notification_sent_at` and status fields populated.
- [ ] Move lead into managed state and confirm `lead_managed_at` is written.
- [ ] Convert lead and verify transitions in order:
  - [ ] `lead_converted`
  - [ ] `organization_created`
  - [ ] `owner_account_created`
  - [ ] `workspace_provisioned`
- [ ] Verify `conversion_status` is `succeeded` after full conversion.
- [ ] Verify owner linkage exists (`organization_users` owner membership and `demo_owner_user_id` when assigned).
- [ ] Confirm audit events are created for conversion success/failure and lead updates.

## 2) Demo scheduling workflow
- [ ] From Operator Lead detail/actions, use **Schedule Demo**.
- [ ] Validate required inputs are captured: lead, owner/rep, date/time, timezone, duration, meeting type, notes.
- [ ] Confirm `operator_lead_demo_events` row is created with lifecycle `scheduled` (or `proposed` when used).
- [ ] Confirm lead timestamps update:
  - [ ] `demo_first_scheduled_at`
  - [ ] `demo_last_scheduled_at`
- [ ] Confirm lead status maps to `demo_scheduled` (unless already converted) and funnel stage stays at least `lead_managed`.
- [ ] Reschedule demo and confirm `lifecycle_status = rescheduled` plus `last_rescheduled_at` update.
- [ ] Mark outcomes and validate:
  - [ ] `completed` requires one completed outcome selection (`interested`, `follow_up_needed`, `needs_website_services`, `not_qualified`, `converted`) and writes `demo_completed_at`.
  - [ ] `no_show` writes `demo_no_show_at`, keeps lead in `demo_scheduled`, sets follow-up due.
  - [ ] `cancelled` keeps lead in `demo_scheduled`, sets follow-up due.
- [ ] Confirm each action writes an audit event in `operator_lead_audit_logs`.

## 3) Notifications, reminders, and secure links
- [ ] Confirm notification queue rows are created for:
  - [ ] schedule confirmation
  - [ ] T-24h reminder
  - [ ] T-1h reminder
  - [ ] T+2h follow-up
- [ ] Run `demo_process_notifications` and verify send attempts update status/attempt counters.
- [ ] Validate failure retry metadata (`status`, `attempt_count`, `error_reason`, `next_attempt_at`).
- [ ] Validate schedule confirmation email includes ICS attachment.
- [ ] Validate confirm/reschedule/cancel links are tokenized and accepted only when token is valid.
- [ ] Confirm token link clicks create audit entries.

## 4) Ownership + SLA visibility
- [ ] Validate default owner assignment uses lead owner when available.
- [ ] Validate fallback assignment uses round-robin active reps.
- [ ] Reassign owner with reason and confirm audit event contains reason.
- [ ] Validate demo list filtering by owner and upcoming demos.
- [ ] Validate SLA view flags demos with overdue outcomes after configured threshold.

## 5) Pilot readiness criteria
- [ ] Pilot group configured and only pilot reps use scheduling path.
- [ ] Weekly KPIs tracked:
  - [ ] Lead -> Demo scheduled rate
  - [ ] Demo scheduled -> Demo completed rate
  - [ ] Demo completed -> Converted rate
  - [ ] No-show rate
  - [ ] Demo completed -> Conversion start rate
- [ ] Phase exit decision is based on scheduling reliability, reminder success rate, and conversion lift.
