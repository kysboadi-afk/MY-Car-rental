-- supabase/migrations/0184_operator_lead_demo_scheduling.sql
-- Phase 1 demo scheduling workflow storage + lead lifecycle timestamps.

BEGIN;

ALTER TABLE public.operator_leads
  ADD COLUMN IF NOT EXISTS demo_first_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demo_last_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demo_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demo_no_show_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demo_follow_up_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demo_owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS demo_owner_reason TEXT;

CREATE TABLE IF NOT EXISTS public.operator_demo_reps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,
  email TEXT,
  display_name TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  assignment_rank INTEGER,
  last_assigned_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operator_demo_reps_contact_check CHECK (
    COALESCE(NULLIF(BTRIM(user_id), ''), NULLIF(BTRIM(email), '')) IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_demo_reps_user
  ON public.operator_demo_reps (user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_demo_reps_email
  ON public.operator_demo_reps (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.operator_lead_demo_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.operator_leads(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  owner_email TEXT,
  owner_name TEXT,
  assigned_reason TEXT,
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  meeting_type TEXT NOT NULL,
  meeting_link TEXT,
  location_label TEXT,
  notes TEXT,
  lifecycle_status TEXT NOT NULL,
  lifecycle_detail TEXT,
  proposed_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  last_rescheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  no_show_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  follow_up_due_at TIMESTAMPTZ,
  reminder_24h_sent_at TIMESTAMPTZ,
  reminder_1h_sent_at TIMESTAMPTZ,
  follow_up_sent_at TIMESTAMPTZ,
  confirmation_sent_at TIMESTAMPTZ,
  notification_last_attempt_at TIMESTAMPTZ,
  notification_attempt_count INTEGER NOT NULL DEFAULT 0,
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_error_reason TEXT,
  calendar_provider TEXT,
  external_event_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operator_lead_demo_events_status_check CHECK (
    lifecycle_status IN ('proposed', 'scheduled', 'rescheduled', 'completed', 'no_show', 'cancelled')
  ),
  CONSTRAINT operator_lead_demo_events_meeting_type_check CHECK (
    meeting_type IN ('zoom', 'phone', 'in_person')
  ),
  CONSTRAINT operator_lead_demo_events_duration_check CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  CONSTRAINT operator_lead_demo_events_notification_status_check CHECK (
    notification_status IN ('pending', 'partial', 'sent', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_operator_lead_demo_events_lead
  ON public.operator_lead_demo_events (lead_id, scheduled_start_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_lead_demo_events_owner_upcoming
  ON public.operator_lead_demo_events (owner_user_id, lifecycle_status, scheduled_start_at);

CREATE INDEX IF NOT EXISTS idx_operator_lead_demo_events_status
  ON public.operator_lead_demo_events (lifecycle_status, scheduled_start_at);

CREATE TABLE IF NOT EXISTS public.operator_lead_demo_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demo_id UUID NOT NULL REFERENCES public.operator_lead_demo_events(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES public.operator_leads(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  error_reason TEXT,
  token_hash TEXT,
  token_expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operator_lead_demo_notifications_type_check CHECK (
    notification_type IN ('schedule_confirmation', 'reminder_24h', 'reminder_1h', 'follow_up_2h')
  ),
  CONSTRAINT operator_lead_demo_notifications_status_check CHECK (
    status IN ('pending', 'retry', 'sent', 'failed', 'cancelled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_lead_demo_notifications_unique
  ON public.operator_lead_demo_notifications (demo_id, notification_type, channel);

CREATE INDEX IF NOT EXISTS idx_operator_lead_demo_notifications_due
  ON public.operator_lead_demo_notifications (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_operator_lead_demo_notifications_demo
  ON public.operator_lead_demo_notifications (demo_id, created_at DESC);

GRANT ALL ON TABLE public.operator_demo_reps TO service_role;
GRANT ALL ON TABLE public.operator_lead_demo_events TO service_role;
GRANT ALL ON TABLE public.operator_lead_demo_notifications TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
