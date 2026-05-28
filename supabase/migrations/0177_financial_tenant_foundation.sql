-- 0177_financial_tenant_foundation.sql
-- Adds additive organization_id scaffolding to the first financial truth tables.
-- This keeps legacy callers working by backfilling from booking/customer links and
-- using the default organization only when no stronger relationship can be found.

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
      'seeded_by_migration', '0177_financial_tenant_foundation'
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
       and table_name = 'revenue_records'
  ) then
    alter table public.revenue_records
      add column if not exists organization_id uuid;

    alter table public.revenue_records
      alter column organization_id set default public.ensure_default_organization();

    update public.revenue_records rr
       set organization_id = b.organization_id
      from public.bookings b
     where rr.organization_id is null
       and b.organization_id is not null
       and (
         (rr.booking_ref is not null and b.booking_ref = rr.booking_ref)
         or (rr.original_booking_id is not null and b.booking_ref = rr.original_booking_id)
         or (rr.booking_id is not null and b.booking_ref = rr.booking_id)
       );

    update public.revenue_records rr
       set organization_id = c.organization_id
      from public.customers c
     where rr.organization_id is null
       and rr.customer_email is not null
       and c.organization_id is not null
       and lower(btrim(c.email)) = lower(btrim(rr.customer_email));

    update public.revenue_records
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'revenue_records_organization_id_fkey'
    ) then
      alter table public.revenue_records
        add constraint revenue_records_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists revenue_records_organization_id_idx
      on public.revenue_records (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_revenue_records_assign_default_organization_id'
    ) then
      create trigger trg_revenue_records_assign_default_organization_id
        before insert or update of organization_id on public.revenue_records
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
       and table_name = 'renter_balance_ledger'
  ) then
    alter table public.renter_balance_ledger
      add column if not exists organization_id uuid;

    alter table public.renter_balance_ledger
      alter column organization_id set default public.ensure_default_organization();

    update public.renter_balance_ledger rbl
       set organization_id = b.organization_id
      from public.bookings b
     where rbl.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = rbl.booking_id;

    update public.renter_balance_ledger rbl
       set organization_id = c.organization_id
      from public.customers c
     where rbl.organization_id is null
       and rbl.customer_id is not null
       and c.organization_id is not null
       and c.id = rbl.customer_id;

    update public.renter_balance_ledger
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'renter_balance_ledger_organization_id_fkey'
    ) then
      alter table public.renter_balance_ledger
        add constraint renter_balance_ledger_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists renter_balance_ledger_organization_id_idx
      on public.renter_balance_ledger (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_renter_balance_ledger_assign_default_organization_id'
    ) then
      create trigger trg_renter_balance_ledger_assign_default_organization_id
        before insert or update of organization_id on public.renter_balance_ledger
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
       and table_name = 'payment_plans'
  ) then
    alter table public.payment_plans
      add column if not exists organization_id uuid;

    alter table public.payment_plans
      alter column organization_id set default public.ensure_default_organization();

    update public.payment_plans pp
       set organization_id = b.organization_id
      from public.bookings b
     where pp.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = pp.booking_id;

    update public.payment_plans pp
       set organization_id = c.organization_id
      from public.customers c
     where pp.organization_id is null
       and pp.customer_email is not null
       and c.organization_id is not null
       and lower(btrim(c.email)) = lower(btrim(pp.customer_email));

    update public.payment_plans
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'payment_plans_organization_id_fkey'
    ) then
      alter table public.payment_plans
        add constraint payment_plans_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists payment_plans_organization_id_idx
      on public.payment_plans (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_payment_plans_assign_default_organization_id'
    ) then
      create trigger trg_payment_plans_assign_default_organization_id
        before insert or update of organization_id on public.payment_plans
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
       and table_name = 'payment_plan_installments'
  ) then
    alter table public.payment_plan_installments
      add column if not exists organization_id uuid;

    alter table public.payment_plan_installments
      alter column organization_id set default public.ensure_default_organization();

    update public.payment_plan_installments ppi
       set organization_id = pp.organization_id
      from public.payment_plans pp
     where ppi.organization_id is null
       and pp.organization_id is not null
       and pp.id = ppi.plan_id;

    update public.payment_plan_installments
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'payment_plan_installments_organization_id_fkey'
    ) then
      alter table public.payment_plan_installments
        add constraint payment_plan_installments_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists payment_plan_installments_organization_id_idx
      on public.payment_plan_installments (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_payment_plan_installments_assign_default_organization_id'
    ) then
      create trigger trg_payment_plan_installments_assign_default_organization_id
        before insert or update of organization_id on public.payment_plan_installments
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;
