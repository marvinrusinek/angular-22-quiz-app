-- Quiz resources — the "Brush up your knowledge of X with these resources"
-- panel on the Results/Statistics page.
--
-- This is the LAST piece of the quiz bank with no home outside
-- `data/quiz.json`. It lives in a separate top-level `resources` block in that
-- file rather than inside each quiz, which is why the quiz-bank migration
-- (002) did not carry it: the block is keyed by `quizId` and duplicates the
-- quiz's own `milestone`, so it reads as a sibling table, not a quiz column.
--
-- ── WHAT IS AND IS NOT STORED ──────────────────────────────────────
--
-- Each source item is exactly `{ title, url, host }` — all three render in the
-- panel, and nothing else exists on them. The source entry ALSO carries a
-- `milestone`, which is not stored: it is byte-identical to `quizzes.milestone`
-- for every entry that has a quiz, and the component takes the name it
-- displays from the quiz metadata rather than from the resource block. Storing
-- it would create a second copy of a title that can drift.
--
-- PUBLIC BY DESIGN. Unlike `questions.explanation` and `options.is_correct`,
-- nothing here is part of the answer key — these are outbound links to public
-- documentation. The endpoint that serves them is classified accordingly.
--
-- ── ORDER AND IDENTITY ─────────────────────────────────────────────
--
-- `display_order` preserves the source array order, which is the order the
-- panel lists them in; the JSON has no other ordering key.
--
-- UNIQUE (quiz_pk, url) is justified by the data AND by the UI: all 30 items
-- have distinct urls, and the template tracks the list with
-- `@for (... ; track resource.url)`, so two items sharing a url inside one
-- quiz would collapse in the rendered list. The constraint makes that
-- unrepresentable rather than a silent rendering bug.
--
-- ── ONE SOURCE ENTRY IS DELIBERATELY NOT IMPORTABLE ────────────────
--
-- `TS_Quiz` has no matching quiz: the TypeScript quiz's id is `typescript`.
-- The Angular lookup is `quizResources.find(r => r.quizId === quizId)`, so
-- those 4 items have never been reachable in the UI and are dropped by this
-- foreign key rather than being remapped — remapping would make content appear
-- that has never been displayed. See the importer for the same note.

CREATE TABLE IF NOT EXISTS quiz_resources (
  id            BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- INTERNAL
  quiz_pk       BIGINT  NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,

  title         TEXT    NOT NULL CHECK (length(btrim(title)) > 0),
  url           TEXT    NOT NULL CHECK (length(btrim(url)) > 0),

  -- The attribution shown after the title ("— Angular website"). Defaulted
  -- rather than nullable, matching `quizzes.summary` / `quizzes.image`.
  host          TEXT    NOT NULL DEFAULT '',

  display_order INTEGER NOT NULL CHECK (display_order >= 0),

  UNIQUE (quiz_pk, display_order),
  UNIQUE (quiz_pk, url)
);

CREATE INDEX IF NOT EXISTS idx_quiz_resources_quiz
  ON quiz_resources (quiz_pk, display_order);
