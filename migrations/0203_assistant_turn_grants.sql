-- Verified owner authorizations of a turn, written only by trusted code after the owner's quote and the
-- action intent were verified (never from a model argument). A background job that acts on the owner's
-- authority (logging orders found in the mailbox) is checked against this record before it writes.
ALTER TABLE assistant_turns ADD COLUMN grants_json TEXT NOT NULL DEFAULT '[]';
