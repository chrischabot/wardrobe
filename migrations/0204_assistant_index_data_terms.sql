-- Words of a message that are not speech: an owner message's attachments and an assistant message's tool
-- calls and tool results. Never used for recall. Used only when a message is forgotten, to find the later
-- messages and records that reused its words (third review, finding C).
ALTER TABLE conversation_index ADD COLUMN data_terms TEXT NOT NULL DEFAULT '';
