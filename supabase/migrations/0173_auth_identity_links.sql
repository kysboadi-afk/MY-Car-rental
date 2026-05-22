-- 0173_auth_identity_links.sql
-- Adds identity-link and auth-audit tables used by phased renter/admin auth rollout.

create table if not exists public.booking_identity_links (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  auth_user_id uuid null,
  email text null,
  phone text null,
  role text not null default 'renter',
  linked_at timestamptz not null default now(),
  last_login_at timestamptz null,
  last_auth_method text null,
  constraint booking_identity_links_role_check check (role in ('renter', 'admin', 'support'))
);

create index if not exists booking_identity_links_booking_ref_idx
  on public.booking_identity_links (booking_ref);

create index if not exists booking_identity_links_auth_user_idx
  on public.booking_identity_links (auth_user_id);

create unique index if not exists booking_identity_links_booking_role_unique
  on public.booking_identity_links (booking_ref, role);

create table if not exists public.auth_login_audit (
  id uuid primary key default gen_random_uuid(),
  actor_role text not null,
  actor_id text null,
  booking_ref text null,
  auth_method text not null,
  auth_status text not null,
  ip_address text null,
  user_agent text null,
  created_at timestamptz not null default now(),
  constraint auth_login_audit_role_check check (actor_role in ('admin', 'renter', 'support', 'system')),
  constraint auth_login_audit_status_check check (auth_status in ('success', 'failed', 'locked', 'expired'))
);

create index if not exists auth_login_audit_created_at_idx
  on public.auth_login_audit (created_at desc);

create index if not exists auth_login_audit_booking_ref_idx
  on public.auth_login_audit (booking_ref);

