-- Repoint the 9 quizzes still carrying a raw.githubusercontent.com image URL
-- at locally-bundled, correctly-sized WebP assets shipped with the Angular
-- frontend. Same bare relative-path convention already used successfully by
-- every other quiz's local SVG (e.g. 'assets/images/http.svg') — proven to
-- resolve correctly under the GitHub Pages base href
-- (https://marvinrusinek.github.io/angular-22-quiz-app/).
--
-- Targeted UPDATEs only, not a re-import: this touches exactly the `image`
-- column on 9 known rows, leaving every other field (questions, options,
-- facts, etc.) untouched.
--
-- ROLLOUT ORDERING: the frontend build carrying these WebP files must already
-- be live on GitHub Pages before this migration runs in production — a
-- deployed frontend still on the pre-migration build reads these same rows
-- and would 404 trying to load an asset that doesn't exist yet on the live
-- site. See the rollout plan in the accompanying report; this migration is
-- NOT applied automatically to any shared/production database as part of
-- this change.
UPDATE quizzes SET image = 'assets/images/typescript.webp'          WHERE quiz_id = 'typescript';
UPDATE quizzes SET image = 'assets/images/create-first-app.webp'    WHERE quiz_id = 'create-first-app';
UPDATE quizzes SET image = 'assets/images/templates.webp'           WHERE quiz_id = 'templates';
UPDATE quizzes SET image = 'assets/images/dependency-injection.webp' WHERE quiz_id = 'dependency-injection';
UPDATE quizzes SET image = 'assets/images/component-tree.webp'      WHERE quiz_id = 'component-tree';
UPDATE quizzes SET image = 'assets/images/router.webp'              WHERE quiz_id = 'router';
UPDATE quizzes SET image = 'assets/images/material.webp'            WHERE quiz_id = 'material';
UPDATE quizzes SET image = 'assets/images/forms.webp'                WHERE quiz_id = 'forms';
UPDATE quizzes SET image = 'assets/images/angular-cli.webp'          WHERE quiz_id = 'angular-cli';
