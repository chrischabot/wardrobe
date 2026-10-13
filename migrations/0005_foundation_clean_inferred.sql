-- Foundation: how many of a garment's clean units are clean only by the weekly laundry inference.
--
-- The availability basis shown to the owner must not call an inferred state an observation
-- (specification section 5: "Do not falsely record an observed pickup or return"). The stock replay
-- knows which clean units no wash, return or count was ever observed for; the stock planner
-- materializes that number here whenever it rewrites the garment's balances. It is derived data, like
-- stock_balances: the journal in stock_events remains the source.
--
-- Rows written before this migration read 0 until the garment's stock next changes.
ALTER TABLE garments ADD COLUMN clean_inferred INTEGER NOT NULL DEFAULT 0 CHECK (clean_inferred >= 0);
