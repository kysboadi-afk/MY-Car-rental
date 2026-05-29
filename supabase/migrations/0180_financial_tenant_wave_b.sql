-- supabase/migrations/0180_financial_tenant_wave_b.sql
-- Adds compatibility-safe organization_id scaffolding to the next tier of
-- financial and booking-adjacent tables.
--
-- Tables covered:
--   charges            — extra charges applied to bookings (damages, late fees, etc.)
--   tickets            — violation tickets linked to bookings and customers
--   booking_extensions — paid rental extension records
--   customer_ledger    — append-only shadow ledger per customer
--
-- Backfill strategy (same hierarchy as 0177):
--   1. Resolve from linked booking  (highest confidence)
--   2. Resolve from linked customer (secondary)
--   3. Fall back to default organization (ensures NOT NULL / FK compliance)
--
-- Design principles (unchanged from Wave A):
--   • Additive only — no existing columns, constraints, or triggers are removed.
--   • Idempotent — every statement uses IF NOT EXISTS / ON CONFLICT guards.
--   • Compatibility-safe — legacy callers continue working; default-org trigger
--     ensures every new row gets an organization_id even without a resolved tenant.
--   • No RLS policies — enforcement follows once staging validation passes.
--
-- Blockers before activation:
--   • 0175, 0176, 0177 must be applied first (ensure_default_organization()
--     and the organizations table must exist).
--   • Run 0178_staging_validation.sql to confirm Wave A is complete.
--   • Run 0179_backfill_audit.sql and review results before proceeding to
--     RLS or hard org enforcement.

-- ─── Shared helper: ensure_default_organization() ────────────────────────────
-- Re-declared here (idempotent CREATE OR REPLACE) so this migration is
-- self-contained and safe to apply independently.

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
      'seeded_by_migration', '0180_financial_tenant_wave_b'
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

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: charges
-- ─────────────────────────────────────────────────────────────────────────────
-- charges.booking_id is a text FK to bookings.booking_ref, so we can resolve
-- org directly in one step.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'charges'
  ) then

    alter table public.charges
      add column if not exists organization_id uuid;

    alter table public.charges
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking
    update public.charges c
       set organization_id = b.organization_id
      from public.bookings b
     where c.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = c.booking_id;

    -- Step 2: fall back to default
    update public.charges
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'charges_organization_id_fkey'
    ) then
      alter table public.charges
        add constraint charges_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists charges_organization_id_idx
      on public.charges (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_charges_assign_default_organization_id'
    ) then
      create trigger trg_charges_assign_default_organization_id
        before insert or update of organization_id on public.charges
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: tickets
-- ─────────────────────────────────────────────────────────────────────────────
-- tickets has FKs to both bookings (booking_id → bookings.booking_ref) and
-- customers (customer_id → customers.id).  Resolution priority:
--   booking link → customer link → default.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'tickets'
  ) then

    alter table public.tickets
      add column if not exists organization_id uuid;

    alter table public.tickets
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking
    update public.tickets t
       set organization_id = b.organization_id
      from public.bookings b
     where t.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = t.booking_id;

    -- Step 2: resolve from linked customer (for tickets not linked to a booking)
    update public.tickets t
       set organization_id = c.organization_id
      from public.customers c
     where t.organization_id is null
       and t.customer_id is not null
       and c.organization_id is not null
       and c.id = t.customer_id;

    -- Step 3: fall back to default
    update public.tickets
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'tickets_organization_id_fkey'
    ) then
      alter table public.tickets
        add constraint tickets_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists tickets_organization_id_idx
      on public.tickets (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_tickets_assign_default_organization_id'
    ) then
      create trigger trg_tickets_assign_default_organization_id
        before insert or update of organization_id on public.tickets
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: booking_extensions
-- ─────────────────────────────────────────────────────────────────────────────
-- booking_extensions.booking_id is a text FK to bookings.booking_ref.
-- Resolution is a single join step.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'booking_extensions'
  ) then

    alter table public.booking_extensions
      add column if not exists organization_id uuid;

    alter table public.booking_extensions
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking
    update public.booking_extensions be
       set organization_id = b.organization_id
      from public.bookings b
     where be.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = be.booking_id;

    -- Step 2: fall back to default
    update public.booking_extensions
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'booking_extensions_organization_id_fkey'
    ) then
      alter table public.booking_extensions
        add constraint booking_extensions_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists booking_extensions_organization_id_idx
      on public.booking_extensions (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_booking_extensions_assign_default_organization_id'
    ) then
      create trigger trg_booking_extensions_assign_default_organization_id
        before insert or update of organization_id on public.booking_extensions
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: customer_ledger
-- ─────────────────────────────────────────────────────────────────────────────
-- customer_ledger has a UUID FK to customers (customer_id) and an optional
-- text booking_ref.  Resolution priority:
--   booking link (via booking_ref) → customer link → default.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'customer_ledger'
  ) then

    alter table public.customer_ledger
      add column if not exists organization_id uuid;

    alter table public.customer_ledger
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking (booking_ref → bookings.booking_ref)
    update public.customer_ledger cl
       set organization_id = b.organization_id
      from public.bookings b
     where cl.organization_id is null
       and cl.booking_ref is not null
       and b.organization_id is not null
       and b.booking_ref = cl.booking_ref;

    -- Step 2: resolve from linked customer
    update public.customer_ledger cl
       set organization_id = c.organization_id
      from public.customers c
     where cl.organization_id is null
       and c.organization_id is not null
       and c.id = cl.customer_id;

    -- Step 3: fall back to default
    update public.customer_ledger
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'customer_ledger_organization_id_fkey'
    ) then
      alter table public.customer_ledger
        add constraint customer_ledger_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists customer_ledger_organization_id_idx
      on public.customer_ledger (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_customer_ledger_assign_default_organization_id'
    ) then
      create trigger trg_customer_ledger_assign_default_organization_id
        before insert or update of organization_id on public.customer_ledger
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;
