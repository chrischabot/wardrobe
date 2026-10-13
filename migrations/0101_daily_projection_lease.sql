-- Calendar projection lease ownership (daily service, specification section 9).
--
-- `lock_until` alone cannot tell two projectors apart: when one projector's lease runs out during a
-- slow Calendar request, a second one may take it, and the first must then neither write the row nor
-- release the second one's lease. Each projector now writes a random token with the lease, renews and
-- writes only while the row still carries that token, and releases only its own token.
ALTER TABLE calendar_projections ADD COLUMN lock_token TEXT;

-- The event ID a projector set out to delete. Recorded before the delete call and cleared once the event
-- is seen gone (and the row suppressed) or still there: the delivered basis is kept meanwhile, so a delete
-- that fails loses nothing, and an event gone by our own hand is never read as the owner's deletion.
ALTER TABLE calendar_projections ADD COLUMN removing_event_id TEXT;

-- The lease token of the projector that recorded `removing_event_id`: only that projector may withdraw the
-- intent after a delete that definitely did not happen, never one whose lease ran out before another
-- projector recorded an intent of its own.
ALTER TABLE calendar_projections ADD COLUMN removing_token TEXT;

-- The events (a JSON array of [calendar ID, event ID] pairs) where a write of ours to this row's event may
-- still land: a call whose outcome is unknown (no answer, a server error, given up at its deadline). Until a
-- later write of ours to that event succeeds (changing its etag, or claiming its ID), the projector never
-- treats what it reads there as settled: it writes again even when the event already looks current, and it
-- fences a missing event before recording the day as removed or as deleted by the owner.
ALTER TABLE calendar_projections ADD COLUMN uncertain_calendars TEXT;

-- The managed texts (a JSON array, newest first) of writes of ours that may have landed but were not
-- verified, and the verified text of an event left behind in an earlier calendar (recorded before each
-- write or move, cleared once a projection is verified with no write of ours outstanding; at most eight
-- are kept only while none is outstanding): such lines in the event are ours, never the owner's notes.
ALTER TABLE calendar_projections ADD COLUMN attempted_text TEXT;
