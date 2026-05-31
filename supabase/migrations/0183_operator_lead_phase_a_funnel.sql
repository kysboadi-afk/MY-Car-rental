-- supabase/migrations/0183_operator_lead_phase_a_funnel.sql
-- Phase A lead funnel observability + notification/conversion workflow fields.

BEGIN;

ALTER TABLE public.operator_leads
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS submission_hash TEXT,
  ADD COLUMN IF NOT EXISTS funnel_stage TEXT,
  ADD COLUMN IF NOT EXISTS lead_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_status TEXT,
  ADD COLUMN IF NOT EXISTS notification_channel TEXT,
  ADD COLUMN IF NOT EXISTS notification_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_error_reason TEXT,
  ADD COLUMN IF NOT EXISTS notification_attempt_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lead_managed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lead_converted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS organization_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_account_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS workspace_provisioned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS conversion_status TEXT,
  ADD COLUMN IF NOT EXISTS conversion_error_reason TEXT;

UPDATE public.operator_leads
   SET lead_submitted_at = COALESCE(lead_submitted_at, created_at, NOW()),
       notification_status = COALESCE(notification_status, CASE
         WHEN notification_sent_at IS NOT NULL THEN 'sent'
         ELSE 'queued'
       END),
       notification_channel = COALESCE(NULLIF(BTRIM(notification_channel), ''), 'email'),
       notification_attempt_count = COALESCE(notification_attempt_count, 0),
       metadata = COALESCE(metadata, '{}'::jsonb),
       conversion_status = COALESCE(conversion_status, CASE
         WHEN workspace_provisioned_at IS NOT NULL THEN 'succeeded'
         WHEN organization_id IS NOT NULL THEN 'in_progress'
         ELSE 'not_started'
       END),
       funnel_stage = COALESCE(NULLIF(BTRIM(funnel_stage), ''), CASE
         WHEN workspace_provisioned_at IS NOT NULL THEN 'workspace_provisioned'
         WHEN owner_account_created_at IS NOT NULL THEN 'owner_account_created'
         WHEN organization_created_at IS NOT NULL OR organization_id IS NOT NULL THEN 'organization_created'
         WHEN lead_converted_at IS NOT NULL OR status = 'active_operator' THEN 'lead_converted'
         WHEN lead_managed_at IS NOT NULL OR status IN ('contacted', 'demo_scheduled', 'onboarding', 'rejected') THEN 'lead_managed'
         WHEN notification_sent_at IS NOT NULL THEN 'notification_sent'
         ELSE 'lead_submitted'
       END);

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'operator_leads'
       AND c.contype = 'c'
       AND c.conname IN (
         'operator_leads_funnel_stage_check',
         'operator_leads_notification_status_check',
         'operator_leads_conversion_status_check'
       )
  LOOP
    EXECUTE format('ALTER TABLE public.operator_leads DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.operator_leads
  ADD CONSTRAINT operator_leads_funnel_stage_check
    CHECK (funnel_stage IN (
      'lead_submitted',
      'notification_sent',
      'lead_managed',
      'lead_converted',
      'organization_created',
      'owner_account_created',
      'workspace_provisioned'
    )),
  ADD CONSTRAINT operator_leads_notification_status_check
    CHECK (notification_status IN ('queued', 'sent', 'failed')),
  ADD CONSTRAINT operator_leads_conversion_status_check
    CHECK (conversion_status IN ('not_started', 'in_progress', 'succeeded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_operator_leads_submission_hash
  ON public.operator_leads (submission_hash);
CREATE INDEX IF NOT EXISTS idx_operator_leads_funnel_stage
  ON public.operator_leads (funnel_stage);
CREATE INDEX IF NOT EXISTS idx_operator_leads_notification_status
  ON public.operator_leads (notification_status);
CREATE INDEX IF NOT EXISTS idx_operator_leads_conversion_status
  ON public.operator_leads (conversion_status);

CREATE TABLE IF NOT EXISTS public.operator_lead_audit_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID        NOT NULL REFERENCES public.operator_leads(id) ON DELETE CASCADE,
  event      TEXT        NOT NULL,
  outcome    TEXT        NOT NULL DEFAULT 'success',
  channel    TEXT,
  detail     TEXT,
  metadata   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_lead_audit_logs_lead_created
  ON public.operator_lead_audit_logs (lead_id, created_at DESC);

GRANT ALL ON TABLE public.operator_lead_audit_logs TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
