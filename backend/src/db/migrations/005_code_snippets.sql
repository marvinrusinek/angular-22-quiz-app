-- Code-based questions: an optional, read-only code snippet shown alongside
-- a question's text.
--
-- Three flat columns rather than JSONB: this schema has no JSONB usage
-- anywhere (`facts_json`/`config_json`/`result_json` are all TEXT with
-- app-level JSON.stringify/parse), and a flat column lets `code_language` keep
-- a real CHECK-constrained enum instead of a JSONB path expression.
--
-- `code` is deliberately independent of `question_text`/`question_key` — the
-- generated `question_key` column is this schema's entire text-identity
-- contract for `/check` and lookups, and concatenating a snippet into it would
-- corrupt that normalization guarantee. A snippet is question CONTENT, not
-- part of the question's identity.
--
-- 0-or-1 snippet per question: `code`/`code_filename` are nullable and
-- unconstrained beyond non-blank-if-present; `code_language` is required
-- WHENEVER `code` is present (a snippet with no declared language cannot be
-- highlighted), and must be NULL when `code` is absent, so a row can never end
-- up "half a snippet".
--
-- Additive and non-destructive: every existing row gets NULL in all three
-- columns and keeps loading exactly as before.
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS code_language TEXT
    CHECK (code_language IS NULL OR code_language IN ('typescript', 'html', 'css', 'json')),
  ADD COLUMN IF NOT EXISTS code_filename TEXT
    CHECK (code_filename IS NULL OR length(btrim(code_filename)) > 0);

ALTER TABLE questions
  ADD CONSTRAINT questions_code_language_required_with_code
    CHECK (
      (code IS NULL AND code_language IS NULL)
      OR (code IS NOT NULL AND length(btrim(code)) > 0 AND code_language IS NOT NULL)
    );

-- `session_questions` (Interview Mode's own frozen per-session copy — a
-- DIFFERENT table from `questions`, per Mark for Review's `flagged` column)
-- mirrors the same three columns, populated once at session-creation time
-- from the master bank, so an Interview session's snippet is immune to a
-- later edit of the source question.
ALTER TABLE session_questions
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS code_language TEXT
    CHECK (code_language IS NULL OR code_language IN ('typescript', 'html', 'css', 'json')),
  ADD COLUMN IF NOT EXISTS code_filename TEXT
    CHECK (code_filename IS NULL OR length(btrim(code_filename)) > 0);

ALTER TABLE session_questions
  ADD CONSTRAINT session_questions_code_language_required_with_code
    CHECK (
      (code IS NULL AND code_language IS NULL)
      OR (code IS NOT NULL AND length(btrim(code)) > 0 AND code_language IS NOT NULL)
    );
