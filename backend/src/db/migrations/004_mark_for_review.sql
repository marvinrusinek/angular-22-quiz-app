-- Mark for Review (Interview Mode only).
--
-- The flag lives on `session_questions`, not `session_answers`: every question
-- gets a `session_questions` row eagerly at session creation, while
-- `session_answers` gets a row ONLY once the question is answered (its
-- `selected_option_ids` column is CHECKed non-empty). Storing the flag on
-- `session_answers` would make it structurally impossible to mark an
-- unanswered question. Storing it here means marking never creates, requires,
-- or implies an answer.
--
-- Defaults to 0 (not flagged) for every existing row, so a session created
-- before this migration reads as entirely unflagged rather than failing to
-- hydrate.
ALTER TABLE session_questions
  ADD COLUMN IF NOT EXISTS flagged SMALLINT NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1));
