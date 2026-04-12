-- 0047_customers_profitability_columns.sql
-- Adds financial profitability metrics to the customers table.
-- All columns are nullable so existing rows are unaffected until the next sync.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_gross_revenue         numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_stripe_fees           numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_net_revenue           numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS associated_vehicle_expenses numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_profit                numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS profit_per_booking          numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avg_profit_per_day          numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lifetime_value              numeric(10,2);

-- Index for sorting/filtering by profit
CREATE INDEX IF NOT EXISTS customers_total_profit_idx ON customers (total_profit);
