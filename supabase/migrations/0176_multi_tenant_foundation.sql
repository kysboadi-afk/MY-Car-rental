-- 0176_multi_tenant_foundation.sql
-- Wave 1 multi-tenant foundation (incremental compatibility migration).

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active',
  is_demo boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_status_check check (status in ('active', 'suspended', 'archived'))
);

create table if not exists public.organization_roles (
  role_key text primary key,
  scope text not null default 'operator',
  description text null,
  created_at timestamptz not null default now(),
  constraint organization_roles_scope_check check (scope in ('operator', 'platform'))
);

insert into public.organization_roles (role_key, scope, description)
values
  ('owner', 'operator', 'Organization owner'),
  ('admin', 'operator', 'Organization administrator'),
  ('manager', 'operator', 'Organization manager'),
  ('staff', 'operator', 'Organization staff member'),
  ('viewer', 'operator', 'Read-only organization user'),
  ('superadmin', 'platform', 'Platform super administrator')
on conflict (role_key) do nothing;

create table if not exists public.organization_users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  auth_user_id uuid null,
  email text not null,
  display_name text null,
  role_key text not null references public.organization_roles(role_key),
  status text not null default 'active',
  invited_by text null,
  last_seen_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_users_status_check check (status in ('invited', 'active', 'suspended', 'removed'))
);

create unique index if not exists organization_users_org_email_unique
  on public.organization_users (organization_id, lower(email));

create unique index if not exists organization_users_org_auth_user_unique
  on public.organization_users (organization_id, auth_user_id)
  where auth_user_id is not null;

create index if not exists organization_users_org_role_idx
  on public.organization_users (organization_id, role_key);

create table if not exists public.organization_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  timezone text not null default 'America/Los_Angeles',
  currency text not null default 'USD',
  locale text not null default 'en-US',
  operational_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  status text not null default 'disconnected',
  external_account_id text null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_integrations_status_check check (status in ('disconnected', 'connected', 'error', 'disabled'))
);

create unique index if not exists organization_integrations_org_provider_unique
  on public.organization_integrations (organization_id, provider);

create table if not exists public.organization_billing (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  plan_key text not null default 'starter',
  status text not null default 'trialing',
  stripe_customer_id text null,
  stripe_subscription_id text null,
  trial_ends_at timestamptz null,
  current_period_ends_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_billing_status_check check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled'))
);

create index if not exists organization_billing_plan_status_idx
  on public.organization_billing (plan_key, status);

create table if not exists public.organization_audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_type text not null,
  actor_id text null,
  actor_role text null,
  action text not null,
  target_type text null,
  target_id text null,
  request_id text null,
  ip_address text null,
  user_agent text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint organization_audit_logs_actor_type_check check (actor_type in ('user', 'service', 'system', 'platform'))
);

create index if not exists organization_audit_logs_org_created_idx
  on public.organization_audit_logs (organization_id, created_at desc);

create index if not exists organization_audit_logs_action_idx
  on public.organization_audit_logs (organization_id, action);

-- Wave 1 compatibility: begin nullable organization_id propagation.
alter table if exists public.bookings add column if not exists organization_id uuid null;
alter table if exists public.vehicles add column if not exists organization_id uuid null;
alter table if exists public.customers add column if not exists organization_id uuid null;
alter table if exists public.revenue_records add column if not exists organization_id uuid null;
alter table if exists public.renter_balance_ledger add column if not exists organization_id uuid null;
alter table if exists public.payment_plans add column if not exists organization_id uuid null;
alter table if exists public.charges add column if not exists organization_id uuid null;
alter table if exists public.tickets add column if not exists organization_id uuid null;
alter table if exists public.booking_documents add column if not exists organization_id uuid null;
alter table if exists public.pending_booking_docs add column if not exists organization_id uuid null;

create index if not exists bookings_organization_id_idx on public.bookings (organization_id);
create index if not exists vehicles_organization_id_idx on public.vehicles (organization_id);
create index if not exists customers_organization_id_idx on public.customers (organization_id);
create index if not exists revenue_records_organization_id_idx on public.revenue_records (organization_id);
create index if not exists renter_balance_ledger_organization_id_idx on public.renter_balance_ledger (organization_id);
create index if not exists payment_plans_organization_id_idx on public.payment_plans (organization_id);
create index if not exists charges_organization_id_idx on public.charges (organization_id);
create index if not exists tickets_organization_id_idx on public.tickets (organization_id);
create index if not exists booking_documents_organization_id_idx on public.booking_documents (organization_id);
create index if not exists pending_booking_docs_organization_id_idx on public.pending_booking_docs (organization_id);

-- Seed a compatibility organization for phased cutover.
insert into public.organizations (id, slug, name, status, metadata)
values (
  '00000000-0000-0000-0000-000000000001',
  'legacy-default',
  'Legacy Default Organization',
  'active',
  jsonb_build_object('seeded_by', '0176_multi_tenant_foundation')
)
on conflict (id) do nothing;
