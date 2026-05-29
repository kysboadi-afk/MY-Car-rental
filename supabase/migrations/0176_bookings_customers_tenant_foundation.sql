-- 0176_bookings_customers_tenant_foundation.sql
-- Adds compatibility-safe organization_id scaffolding to the highest-risk tables.
-- This migration is additive, idempotent, and keeps single-tenant behavior working
-- by creating/backfilling a default organization until operator auth and full RLS
-- enforcement are ready.

create or replace function public.ensure_default_organization()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  default_org_id uuid;
begin
  insert into public.organizations (slug, name, status, metadata)
  values (
    'sly-rides-default',
    'SLY Rides Default Organization',
    'active',
    jsonb_build_object(
      'is_default', true,
      'seeded_by_migration', '0176_bookings_customers_tenant_foundation'
    )
  )
  on conflict (slug) do update
    set status = 'active',
        metadata = coalesce(public.organizations.metadata, '{}'::jsonb) || excluded.metadata
  returning id into default_org_id;

  if default_org_id is not null then
    return default_org_id;
  end if;

  select id
    into default_org_id
    from public.organizations
   where slug = 'sly-rides-default'
   limit 1;

  return default_org_id;
end;
$$;

create or replace function public.assign_default_organization_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.organization_id is null then
    new.organization_id := public.ensure_default_organization();
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'bookings'
  ) then
    alter table public.bookings
      add column if not exists organization_id uuid;

    alter table public.bookings
      alter column organization_id set default public.ensure_default_organization();

    update public.bookings
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'bookings_organization_id_fkey'
    ) then
      alter table public.bookings
        add constraint bookings_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists bookings_organization_id_idx
      on public.bookings (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_bookings_assign_default_organization_id'
    ) then
      create trigger trg_bookings_assign_default_organization_id
        before insert or update of organization_id on public.bookings
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'customers'
  ) then
    alter table public.customers
      add column if not exists organization_id uuid;

    alter table public.customers
      alter column organization_id set default public.ensure_default_organization();

    update public.customers
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'customers_organization_id_fkey'
    ) then
      alter table public.customers
        add constraint customers_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists customers_organization_id_idx
      on public.customers (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_customers_assign_default_organization_id'
    ) then
      create trigger trg_customers_assign_default_organization_id
        before insert or update of organization_id on public.customers
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;
