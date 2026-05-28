-- supabase/migrations/0175_organizations_foundation.sql
-- Phase 0 — Multi-tenant SaaS Foundation
--
-- Creates the core organizational schema for Fleet Control's transition to a
-- multi-tenant SaaS platform. All tables are additive — no existing tables are
-- modified. Existing single-tenant data continues to function without changes.
--
-- Tables created:
--   organizations          — tenant/operator accounts
--   organization_users     — user membership + RBAC roles within an org
--   organization_settings  — per-org configuration overrides
--   operator_leads         — onboarding pipeline for prospective operators
--
-- Design principles:
--   • All tenant tables include organization_id for future cross-table joins
--   • status columns use CHECK constraints to enforce valid state machines
--   • All tables include created_at / updated_at for audit trails
--   • Indexes cover the most common query patterns (membership lookups, lead funnel)
--   • No RLS policies yet — Phase 1 will add RLS once Supabase Auth is integrated
--   • No organization_id columns on existing tables yet — Phase 1 migration handles backfill
--
-- Migration strategy:
--   This migration is safe to run against production at any time.
--   IF NOT EXISTS guards make it fully idempotent.
--   Rolling back is safe — dropping these tables does not affect existing data.

-- ─── organizations ────────────────────────────────────────────────────────────
-- Each row represents a fleet operator tenant.
-- status drives access control: only 'active' orgs can log in.

CREATE TABLE IF NOT EXISTS public.organizations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT        NOT NULL UNIQUE,           -- URL-safe identifier, e.g. "sly-rides"
  name          TEXT        NOT NULL,                  -- display name, e.g. "SLY Rides LLC"
  status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'active', 'suspended', 'cancelled')),
  plan          TEXT        NOT NULL DEFAULT 'starter'
                  CHECK (plan IN ('starter', 'growth', 'pro', 'enterprise')),
  owner_email   TEXT,                                  -- primary contact email
  phone         TEXT,                                  -- primary contact phone
  city          TEXT,
  state         TEXT,
  timezone      TEXT        NOT NULL DEFAULT 'America/Los_Angeles',
  metadata      JSONB       NOT NULL DEFAULT '{}',     -- extensible org-level config
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug   ON public.organizations (slug);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON public.organizations (status);

-- ─── organization_users ───────────────────────────────────────────────────────
-- Maps Supabase Auth users to organizations with RBAC roles.
-- A user may belong to multiple organizations (e.g. a consultant managing two fleets).
-- Phase 0: user_id is nullable (pre-Supabase Auth). Phase 1 will make it NOT NULL.

CREATE TABLE IF NOT EXISTS public.organization_users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID,                                -- Supabase Auth user UUID (nullable in Phase 0)
  email           TEXT        NOT NULL,               -- used before Supabase Auth user is created
  role            TEXT        NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member', 'staff')),
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'invited')),
  invited_at      TIMESTAMPTZ,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email)                     -- one membership record per email per org
);

CREATE INDEX IF NOT EXISTS idx_org_users_org_id  ON public.organization_users (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_users_user_id ON public.organization_users (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_users_email   ON public.organization_users (email);

-- ─── organization_settings ────────────────────────────────────────────────────
-- Per-org configuration that overrides platform defaults.
-- Follows the same JSONB-based extensible pattern as the existing system_settings table.
-- Key categories:
--   notifications — SMS/email preferences
--   integrations  — GPS, Stripe Connect account IDs (Phase 4)
--   branding      — logo, colors (Phase 11)
--   operational   — timezone overrides, late-fee schedules

CREATE TABLE IF NOT EXISTS public.organization_settings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  settings        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_settings_org_id ON public.organization_settings (organization_id);

-- ─── operator_leads ──────────────────────────────────────────────────────────
-- Onboarding pipeline for prospective fleet operators.
-- Captures interest from landing page CTAs:
--   "Request Access", "Book Demo", "Start Your System", "Early Access"
--
-- Status machine:
--   new_lead → contacted → demo_scheduled → onboarding → active_operator
--                       ↘ rejected (from any state)
--
-- When status transitions to 'active_operator', a corresponding organizations
-- row should be created and linked via organization_id.

CREATE TABLE IF NOT EXISTS public.operator_leads (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL,
  business_name         TEXT,
  email                 TEXT        NOT NULL,
  phone                 TEXT,
  fleet_size            INTEGER,                        -- self-reported number of vehicles
  location              TEXT,                           -- city / region
  source                TEXT,                           -- CTA that triggered submission, e.g. "request_access"
  status                TEXT        NOT NULL DEFAULT 'new_lead'
                          CHECK (status IN (
                            'new_lead',
                            'contacted',
                            'demo_scheduled',
                            'onboarding',
                            'active_operator',
                            'rejected'
                          )),
  onboarding_notes      TEXT,                           -- internal admin notes
  onboarding_progress   JSONB       NOT NULL DEFAULT '{}',  -- checklist state
  stripe_status         TEXT,                           -- e.g. 'not_started', 'in_progress', 'complete'
  organization_id       UUID        REFERENCES public.organizations(id), -- set when activated
  demo_scheduled_at     TIMESTAMPTZ,
  contacted_at          TIMESTAMPTZ,
  activated_at          TIMESTAMPTZ,
  rejected_at           TIMESTAMPTZ,
  rejection_reason      TEXT,
  metadata              JSONB       NOT NULL DEFAULT '{}',  -- extensible fields
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_leads_status  ON public.operator_leads (status);
CREATE INDEX IF NOT EXISTS idx_operator_leads_email   ON public.operator_leads (email);
CREATE INDEX IF NOT EXISTS idx_operator_leads_created ON public.operator_leads (created_at DESC);

-- ─── updated_at triggers ─────────────────────────────────────────────────────
-- Automatically maintain updated_at on all new tables.
-- Uses the moddatetime extension pattern common in this project.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organizations_updated_at'
  ) THEN
    CREATE TRIGGER set_organizations_updated_at
      BEFORE UPDATE ON public.organizations
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organization_users_updated_at'
  ) THEN
    CREATE TRIGGER set_organization_users_updated_at
      BEFORE UPDATE ON public.organization_users
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organization_settings_updated_at'
  ) THEN
    CREATE TRIGGER set_organization_settings_updated_at
      BEFORE UPDATE ON public.organization_settings
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_operator_leads_updated_at'
  ) THEN
    CREATE TRIGGER set_operator_leads_updated_at
      BEFORE UPDATE ON public.operator_leads
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END;
$$;

-- ─── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.organizations       IS 'Fleet operator tenant accounts. Each row = one SaaS customer.';
COMMENT ON TABLE public.organization_users  IS 'User membership and RBAC roles within an organization.';
COMMENT ON TABLE public.organization_settings IS 'Per-org configuration overrides for platform defaults.';
COMMENT ON TABLE public.operator_leads      IS 'Onboarding pipeline for prospective fleet operators.';

COMMENT ON COLUMN public.organizations.slug   IS 'URL-safe identifier for the org, used in future operator subdomains.';
COMMENT ON COLUMN public.organizations.status IS 'Access gate: only active orgs can authenticate.';
COMMENT ON COLUMN public.organizations.metadata IS 'Extensible JSONB for future org-level flags without schema changes.';

COMMENT ON COLUMN public.organization_users.user_id     IS 'Supabase Auth UUID. Nullable in Phase 0; NOT NULL constraint added in Phase 1.';
COMMENT ON COLUMN public.organization_users.role        IS 'RBAC role: owner > admin > member > staff.';

COMMENT ON COLUMN public.operator_leads.source          IS 'CTA button / page that triggered the lead, e.g. request_access, book_demo.';
COMMENT ON COLUMN public.operator_leads.organization_id IS 'Set when lead is activated and an organizations row is provisioned.';
COMMENT ON COLUMN public.operator_leads.onboarding_progress IS 'JSON checklist of completed onboarding steps.';
