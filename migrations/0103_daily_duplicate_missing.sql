-- Daily service: a 409 for an event ID with no event readable under it is taken as the event being gone for good
-- (its ID kept by Google) only when the same observation, for the same calendar and event ID, repeats on a later
-- attempt. JSON array of {calendarId, eventId, since}: each first observation. An entry is cleared by any read
-- that sees that event, and every entry is cleared when the outfit calendar changes.
ALTER TABLE calendar_projections ADD COLUMN duplicate_missing TEXT;
