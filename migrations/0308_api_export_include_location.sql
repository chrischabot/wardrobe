-- A portable export may include the supplied photographs as supplied, with their location data, when the
-- signed-in owner asks for it for that export (ExportRequest.includeLocation). Off (0) by default and for
-- every earlier job: an export's originals are written without location data.
ALTER TABLE export_jobs ADD COLUMN include_location INTEGER NOT NULL DEFAULT 0 CHECK (include_location IN (0, 1));
