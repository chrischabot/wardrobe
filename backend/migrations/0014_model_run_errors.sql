-- Model run failures keep the provider's own answer (dev deployment follow-up, 2026-09-29).
-- error_class alone ('fatal', 'transport') could not explain a failed assistant run. The message is
-- the provider or gateway error text with credentials redacted by the transport; provider_status is
-- the HTTP status it answered with, when there was one.
ALTER TABLE model_runs ADD COLUMN error_message TEXT;
ALTER TABLE model_runs ADD COLUMN provider_status INTEGER;
