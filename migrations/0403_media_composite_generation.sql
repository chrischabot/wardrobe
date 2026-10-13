-- Visual wardrobe: the render generation of an outfit preview.
--
-- Each preview request queues its own render job. The composite remembers which job is the current one, so
-- a result or a discard from an older job (whose request was superseded) can neither reset nor overwrite the
-- preview of the newer request: both are conditioned, inside their commit, on being the current job. Rows
-- written before this column existed have no current job recorded and accept any job, as before.

ALTER TABLE outfit_composites ADD COLUMN render_job_id TEXT;
