-- 0126_expense_categories.sql
-- Upgrades the expense category system from a flat CHECK-constrained text column
-- to a two-level hierarchy: group → category, stored in a dedicated table.
--
-- Changes:
--   1. Creates expense_categories table (id, name, group_name, is_default, is_active)
--   2. Inserts all default categories across 8 groups
--   3. Adds category_id (nullable UUID FK) to the expenses table
--   4. Backfills category_id for existing rows by mapping old category text values
--   5. Drops the restrictive CHECK constraint on expenses.category so free-text
--      values (and the GitHub-fallback path) continue to work

-- ── 1. expense_categories table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  group_name  text        NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, group_name)
);

CREATE INDEX IF NOT EXISTS expense_categories_group_idx  ON expense_categories (group_name);
CREATE INDEX IF NOT EXISTS expense_categories_active_idx ON expense_categories (is_active);

-- ── 2. Default categories ─────────────────────────────────────────────────────
INSERT INTO expense_categories (name, group_name, is_default, is_active) VALUES
  -- Ownership
  ('Loan / Lease',          'Ownership',   true, true),
  ('Insurance',             'Ownership',   true, true),
  ('Registration',          'Ownership',   true, true),
  ('Taxes',                 'Ownership',   true, true),
  -- Usage
  ('Fuel',                  'Usage',       true, true),
  ('EV Charging',           'Usage',       true, true),
  ('Parking',               'Usage',       true, true),
  ('Tolls',                 'Usage',       true, true),
  -- Maintenance
  ('Oil Change',            'Maintenance', true, true),
  ('Tires',                 'Maintenance', true, true),
  ('Brakes',                'Maintenance', true, true),
  ('Fluids',                'Maintenance', true, true),
  ('Filters',               'Maintenance', true, true),
  ('Battery',               'Maintenance', true, true),
  ('Inspection / Emissions','Maintenance', true, true),
  -- Repairs
  ('Repair (General)',      'Repairs',     true, true),
  ('Parts',                 'Repairs',     true, true),
  ('Labor',                 'Repairs',     true, true),
  ('Diagnostics',           'Repairs',     true, true),
  -- Cleaning
  ('Car Wash',              'Cleaning',    true, true),
  ('Detailing',             'Cleaning',    true, true),
  -- Extras
  ('Accessories',           'Extras',      true, true),
  ('Mods / Upgrades',       'Extras',      true, true),
  ('Subscriptions',         'Extras',      true, true),
  -- Incidents
  ('Fines / Tickets',       'Incidents',   true, true),
  ('Towing',                'Incidents',   true, true),
  ('Accident / Damage',     'Incidents',   true, true),
  ('Insurance Deductible',  'Incidents',   true, true),
  -- Advanced (hidden by default — is_active=false)
  ('Depreciation',          'Advanced',    true, false),
  ('Mileage',               'Advanced',    true, false),
  ('Rental / Replacement',  'Advanced',    true, false),
  -- Legacy fallback (hidden — kept for backward-compat only)
  ('Other',                 'Other',       true, false)
ON CONFLICT (name, group_name) DO NOTHING;

-- ── 3. Add category_id FK to expenses ────────────────────────────────────────
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'expenses_category_id_fkey'
      AND table_name = 'expenses'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES expense_categories(id);
  END IF;
END$$;

-- ── 4. Backfill existing rows ─────────────────────────────────────────────────
UPDATE expenses
SET    category_id = ec.id
FROM   expense_categories ec
WHERE  expenses.category_id IS NULL
  AND (
      (expenses.category = 'maintenance'   AND ec.name = 'Oil Change'        AND ec.group_name = 'Maintenance')
   OR (expenses.category = 'insurance'     AND ec.name = 'Insurance'         AND ec.group_name = 'Ownership')
   OR (expenses.category = 'repair'        AND ec.name = 'Repair (General)'  AND ec.group_name = 'Repairs')
   OR (expenses.category = 'fuel'          AND ec.name = 'Fuel'              AND ec.group_name = 'Usage')
   OR (expenses.category = 'registration'  AND ec.name = 'Registration'      AND ec.group_name = 'Ownership')
   OR (expenses.category IN ('other', '')  AND ec.name = 'Other'             AND ec.group_name = 'Other')
  );

-- ── 5. Relax the CHECK constraint on expenses.category ───────────────────────
-- The category text column is retained for the GitHub-fallback path and legacy
-- display; the CHECK was too restrictive for the new free-text + category_id model.
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
