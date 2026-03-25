-- 0004_sample_data.sql
-- Seeds sample customers and revenue records for the three initial bookings.
--
-- Sample bookings (matching bookings.json):
--   1. David Agbebaku  — Camry 2013 SE, 7 days,  $479.59  (no refund)
--   2. Mariatu Sillah  — Camry 2012,   4 days,  $200.00  (no refund)
--   3. Bernard Gilot   — Camry 2012,  11 days,  $785.00  ($300 refunded → net $485)
--
-- Run AFTER migration 0003 (which creates all required tables).

-- ── Customers ──────────────────────────────────────────────────────────────

INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
VALUES
  ('David Agbebaku',  NULL, NULL, 1, 479.59, '2025-10-01', '2025-10-01'),
  ('Mariatu Sillah',  NULL, NULL, 1, 200.00, '2025-11-15', '2025-11-15'),
  ('Bernard Gilot',   NULL, NULL, 1, 485.00, '2025-12-01', '2025-12-01')
ON CONFLICT DO NOTHING;

-- ── Revenue Records ────────────────────────────────────────────────────────
-- Each booking_id matches the stable ID in bookings.json so duplicate inserts
-- can be detected and avoided by the API layer.

-- David Agbebaku — Camry 2013 SE, 7 days, $479.59
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-da-001', 'camry2013', 'David Agbebaku',
  '2025-10-01', '2025-10-08',
  479.59, 0, 0,
  'stripe', 'paid',
  '7-day rental — sample booking', true
) ON CONFLICT DO NOTHING;

-- Mariatu Sillah — Camry 2012, 4 days, $200
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-ms-001', 'camry', 'Mariatu Sillah',
  '2025-11-15', '2025-11-19',
  200.00, 0, 0,
  'cash', 'paid',
  '4-day rental — sample booking', true
) ON CONFLICT DO NOTHING;

-- Bernard Gilot — Camry 2012, 11 days, $785 gross / $300 refund / $485 net
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-bg-002', 'camry', 'Bernard Gilot',
  '2025-12-01', '2025-12-12',
  785.00, 0, 300.00,
  'cash', 'partial',
  '11-day rental — $300 refunded, net $485', true
) ON CONFLICT DO NOTHING;

-- ── Payment Transactions ───────────────────────────────────────────────────
-- Detailed payment ledger matching the revenue records above.

-- David Agbebaku — single charge
INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-da-001', 'camry2013', 479.59, 'charge', 'stripe', 'completed',
  '7-day rental payment', 'admin'
) ON CONFLICT DO NOTHING;

-- Mariatu Sillah — single charge
INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-ms-001', 'camry', 200.00, 'charge', 'cash', 'completed',
  '4-day rental payment', 'admin'
) ON CONFLICT DO NOTHING;

-- Bernard Gilot — charge + refund
INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-bg-002', 'camry', 785.00, 'charge', 'cash', 'completed',
  '11-day rental payment', 'admin'
) ON CONFLICT DO NOTHING;

INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-bg-002', 'camry', 300.00, 'refund', 'cash', 'completed',
  'Partial refund — $300 back to customer (net $485)', 'admin'
) ON CONFLICT DO NOTHING;
