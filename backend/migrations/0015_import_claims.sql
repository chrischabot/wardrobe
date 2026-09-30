-- One import per owner, claimed atomically (the race behind the adversarial "two different staged
-- packages confirmed at the same time" test). The claim row is written by a single conditional INSERT
-- that also checks the owner is empty, so two confirmations can never both pass the empty-owner check:
-- the second INSERT hits the primary key and changes nothing.
--
-- The owner column is deliberately not named user_id: the export includes every table with a user_id
-- column, and a claim must never travel inside a package (it would collide with the target's own claim).
CREATE TABLE import_claims (
  owner_user TEXT NOT NULL PRIMARY KEY REFERENCES users(user_id),
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('importing', 'imported', 'failed')),
  claimed_at TEXT NOT NULL,
  completed_at TEXT
);
