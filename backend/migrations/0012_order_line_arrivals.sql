-- Migration 0012 (assistant workstream, lifecycle): when an order line's arrival was recorded.
-- Additive only. Delivery-based return deadlines count from this recorded arrival, never from an estimate.
ALTER TABLE order_lines ADD COLUMN arrived_at TEXT;
