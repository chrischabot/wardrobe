-- Assistant lane: when a reconciliation sweep last took up an uncertain model-call reservation.
--
-- The sweep (packages/assistant/src/inference/reconcile.ts) looks up a limited number of uncertain
-- reservations in the provider's record each time it runs. To reach every one of them within a bounded
-- number of sweeps it takes those never looked up first and then those looked up longest ago. This
-- column is that bookkeeping only: it says nothing about what the call cost and is not owner content.
ALTER TABLE inference_reservations ADD COLUMN looked_up_at TEXT;

-- Which version of the indexer wrote a message's entry in the retrieval index. Entries written before
-- migration 0204 hold no `data_terms` (the words of attachments and tool calls), so forgetting such a
-- message could not find where those words went. Existing entries are version 1; the conversation actor
-- re-indexes them once (GarderobeAssistant.projectIndex) and the indexer writes version 2.
ALTER TABLE conversation_index ADD COLUMN index_version INTEGER NOT NULL DEFAULT 1;
