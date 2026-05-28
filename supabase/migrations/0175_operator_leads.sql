create table if not exists public.operator_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'new_lead',
  source_page text not null default 'fleet-control',
  company_name text null,
  contact_name text not null,
  work_email text not null,
  phone text not null,
  fleet_size text not null,
  active_vehicles integer null,
  current_tools text null,
  operational_priority text not null,
  onboarding_readiness text null,
  integration_setup_status text null,
  stripe_readiness text null,
  subscription_state text not null default 'lead',
  walkthrough_requested boolean not null default true,
  notes text not null,
  metadata jsonb not null default '{}'::jsonb,
  constraint operator_leads_status_check check (
    status in (
      'new_lead',
      'contacted',
      'demo_scheduled',
      'onboarding',
      'trial_started',
      'integration_pending',
      'active_operator',
      'paused',
      'rejected'
    )
  ),
  constraint operator_leads_subscription_state_check check (
    subscription_state in ('lead', 'trial', 'active', 'past_due', 'paused', 'cancelled')
  ),
  constraint operator_leads_onboarding_readiness_check check (
    onboarding_readiness is null or onboarding_readiness in ('planning', 'ready_now', 'needs_migration_support', 'evaluating')
  ),
  constraint operator_leads_integration_setup_status_check check (
    integration_setup_status is null or integration_setup_status in ('not_started', 'in_progress', 'ready', 'blocked')
  ),
  constraint operator_leads_stripe_readiness_check check (
    stripe_readiness is null or stripe_readiness in ('unknown', 'not_started', 'needs_setup', 'ready')
  ),
  constraint operator_leads_active_vehicles_check check (
    active_vehicles is null or active_vehicles >= 0
  )
);

create index if not exists operator_leads_created_at_idx
  on public.operator_leads (created_at desc);

create index if not exists operator_leads_status_idx
  on public.operator_leads (status);

create index if not exists operator_leads_work_email_idx
  on public.operator_leads (lower(work_email));
