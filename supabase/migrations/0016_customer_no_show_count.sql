-- supabase/migrations/0016_customer_no_show_count.sql
-- Adds no_show_count to customers and a trigger to keep it in sync
-- automatically whenever is_no_show changes on a revenue_records row.
--
-- Trigger behaviour:
--   INSERT  with is_no_show=true   → increment customer.no_show_count
--   UPDATE false→true              → increment customer.no_show_count
--   UPDATE true→false              → decrement customer.no_show_count (floor 0)
--   DELETE with is_no_show=true    → decrement customer.no_show_count (floor 0)
--
-- The customer is looked up by customer_phone (the key used throughout the
-- system).  Rows with a NULL/empty customer_phone are silently skipped.

-- ── 1. Add column ─────────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS no_show_count integer NOT NULL DEFAULT 0;

-- Ensure the value can never go below zero
DO $$
BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT customers_no_show_count_non_negative
    CHECK (no_show_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Trigger function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_customer_no_show_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_phone text;
  v_delta integer := 0;
BEGIN
  -- Determine which row's phone to use and the direction of the change
  IF TG_OP = 'DELETE' THEN
    v_phone := OLD.customer_phone;
    IF OLD.is_no_show THEN v_delta := -1; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_phone := NEW.customer_phone;
    IF NEW.is_no_show THEN v_delta := 1; END IF;
  ELSE  -- UPDATE
    v_phone := NEW.customer_phone;
    IF     OLD.is_no_show = false AND NEW.is_no_show = true  THEN v_delta :=  1;
    ELSIF  OLD.is_no_show = true  AND NEW.is_no_show = false THEN v_delta := -1;
    END IF;
  END IF;

  -- Nothing to do
  IF v_delta = 0 OR v_phone IS NULL OR v_phone = '' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE customers
     SET no_show_count = GREATEST(0, no_show_count + v_delta),
         updated_at    = now()
   WHERE phone = v_phone;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── 3. Attach trigger ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS on_revenue_no_show_change ON revenue_records;
CREATE TRIGGER on_revenue_no_show_change
  AFTER INSERT OR UPDATE OF is_no_show OR DELETE
  ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION update_customer_no_show_count();

-- =============================================================================
-- DONE
-- customers.no_show_count is now maintained automatically by the
-- on_revenue_no_show_change trigger whenever a revenue_records row has its
-- is_no_show flag toggled.  The column is also readable by v2-customers list
-- and visible in the admin-v2 Customers tab.
-- =============================================================================
