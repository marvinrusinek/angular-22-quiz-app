'use strict';

const { request } = require('./lib/client');
const { compareResponses, compareStatusAndBody, assertRuntimeStatus } = require('./lib/compare');

// ── shared fixture facts (from backend/test/helpers/synthetic-quiz-bank.json) ──
// Picking data OUT of the fixture rather than hardcoding independent
// expectations: if the fixture ever changes, these adapt with it instead of
// silently testing stale assumptions.
const TOPIC_QUIZ_ID = 'fixture-widgets';
const TOPIC_QUIZ_QUESTION_TEXT = 'Which widget size is the smallest?';
const TOPIC_QUIZ_CORRECT_OPTION = 'small';
const TOPIC_QUIZ_WRONG_OPTION = 'medium';
const INTERVIEW_TOPIC_ID = 'fixture-widgets'; // exactly 10 questions — see run.js
const INTERVIEW_QUESTION_COUNT = 10; // must be a member of CUSTOM_QUESTION_COUNTS AND equal fixture-widgets' total question count, so selection is a full take (no sampling randomness) — see scenarios.js's own header comment for why that matters.

// Forbidden in any pre-check Topic Quiz question payload — see requirement
// "no answer keys, correctness flags, or explanations before checking".
const FORBIDDEN_ANSWER_KEYS = ['correct', 'correctOptionTexts', 'correctOptionIds', 'isCorrect', 'explanation'];

function findForbiddenKeyPaths(value, forbiddenKeys, path = '$') {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findForbiddenKeyPaths(v, forbiddenKeys, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    const hits = [];
    for (const [key, v] of Object.entries(value)) {
      if (forbiddenKeys.includes(key)) hits.push(`${path}.${key}`);
      hits.push(...findForbiddenKeyPaths(v, forbiddenKeys, `${path}.${key}`));
    }
    return hits;
  }
  return [];
}

// ── 1. Metadata parity ──────────────────────────────────────────────────────
async function runMetadataScenario({ nodeBase, springBase }) {
  const scenario = 'Metadata parity (GET /api/quizzes)';
  const [nodeRes, springRes] = await Promise.all([
    request(nodeBase, 'GET', '/api/quizzes'),
    request(springBase, 'GET', '/api/quizzes')
  ]);

  const notes = [`Node status=${nodeRes.status}, Spring status=${springRes.status}`];
  if (nodeRes.status !== 200 || springRes.status !== 200) {
    return { scenario, mismatches: [{ endpoint: 'GET /api/quizzes', path: '$.status', expected: nodeRes.status, actual: springRes.status }], notes };
  }

  const mismatches = compareResponses({
    scenario,
    endpoint: 'GET /api/quizzes',
    expectedNode: nodeRes.body,
    actualSpring: springRes.body
    // No ignorePaths: quiz metadata is static fixture content with no
    // generated IDs or timestamps — a genuine byte-for-byte contract.
  });

  notes.push(`Node returned ${nodeRes.body?.quizzes?.length ?? 'N/A'} quizzes; Spring returned ${springRes.body?.quizzes?.length ?? 'N/A'}`);
  return { scenario, mismatches, notes };
}

// ── 2. Topic Quiz parity ────────────────────────────────────────────────────
async function issueAttemptReceipt(base, quizId) {
  const res = await request(base, 'POST', `/api/quizzes/${quizId}/attempts`, {
    headers: { 'content-type': 'application/json' },
    body: {}
  });
  if (res.status !== 201 || typeof res.body?.attemptReceipt !== 'string') {
    throw new Error(`Failed to issue attempt receipt from ${base}: status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  return res.body.attemptReceipt;
}

async function issueQuestionReceipt(base, quizId, attemptReceipt, questionText) {
  const res = await request(base, 'POST', `/api/quizzes/${quizId}/questions/start`, {
    headers: { 'X-Attempt-Receipt': attemptReceipt, 'content-type': 'application/json' },
    body: { questionText }
  });
  if (res.status !== 201 || typeof res.body?.questionReceipt !== 'string') {
    throw new Error(`Failed to issue question receipt from ${base}: status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  return res.body.questionReceipt;
}

async function checkAnswer(base, quizId, questionReceipt, questionText, selectedOptionTexts) {
  return request(base, 'POST', `/api/quizzes/${quizId}/check`, {
    headers: { 'X-Question-Receipt': questionReceipt, 'content-type': 'application/json' },
    body: { questionText, selectedOptionTexts }
  });
}

async function runTopicQuizScenario({ nodeBase, springBase }) {
  const scenario = 'Topic Quiz parity (receipts, answer-check, error contracts)';
  const mismatches = [];
  const notes = [];

  // (a) no answer keys before checking — both runtimes' question payloads.
  const [nodeQuestions, springQuestions] = await Promise.all([
    request(nodeBase, 'GET', `/api/quizzes/${TOPIC_QUIZ_ID}/questions`),
    request(springBase, 'GET', `/api/quizzes/${TOPIC_QUIZ_ID}/questions`)
  ]);
  for (const [label, res] of [['Node', nodeQuestions], ['Spring', springQuestions]]) {
    const hits = findForbiddenKeyPaths(res.body, FORBIDDEN_ANSWER_KEYS);
    for (const path of hits) {
      mismatches.push({ endpoint: `GET /api/quizzes/${TOPIC_QUIZ_ID}/questions`, path, expected: `no ${path} key`, actual: `${label} included it` });
    }
  }
  const metaMismatches = compareResponses({
    scenario,
    endpoint: `GET /api/quizzes/${TOPIC_QUIZ_ID}/questions`,
    expectedNode: nodeQuestions.body,
    actualSpring: springQuestions.body
  });
  mismatches.push(...metaMismatches);

  // (b) Node-issued receipt accepted by Spring, and vice versa.
  const nodeAttempt = await issueAttemptReceipt(nodeBase, TOPIC_QUIZ_ID);
  const nodeQuestionReceipt = await issueQuestionReceipt(nodeBase, TOPIC_QUIZ_ID, nodeAttempt, TOPIC_QUIZ_QUESTION_TEXT);
  const acceptedBySpring = await checkAnswer(springBase, TOPIC_QUIZ_ID, nodeQuestionReceipt, TOPIC_QUIZ_QUESTION_TEXT, [TOPIC_QUIZ_CORRECT_OPTION]);
  notes.push(`Node-issued question receipt presented to Spring /check -> status ${acceptedBySpring.status}`);
  if (acceptedBySpring.status !== 200) {
    mismatches.push({ endpoint: 'POST /check (Node receipt -> Spring)', path: '$.status', expected: 200, actual: acceptedBySpring.status });
  }

  const springAttempt = await issueAttemptReceipt(springBase, TOPIC_QUIZ_ID);
  const springQuestionReceipt = await issueQuestionReceipt(springBase, TOPIC_QUIZ_ID, springAttempt, TOPIC_QUIZ_QUESTION_TEXT);
  const acceptedByNode = await checkAnswer(nodeBase, TOPIC_QUIZ_ID, springQuestionReceipt, TOPIC_QUIZ_QUESTION_TEXT, [TOPIC_QUIZ_CORRECT_OPTION]);
  notes.push(`Spring-issued question receipt presented to Node /check -> status ${acceptedByNode.status}`);
  if (acceptedByNode.status !== 200) {
    mismatches.push({ endpoint: 'POST /check (Spring receipt -> Node)', path: '$.status', expected: 200, actual: acceptedByNode.status });
  }

  // (c) equivalent correctness/shape for the SAME input, each runtime
  // checking its OWN self-issued receipt (deterministic — no per-session
  // randomness in Topic Quiz, so a plain deep-compare is valid here).
  const nodeOwnCheck = await checkAnswer(nodeBase, TOPIC_QUIZ_ID, nodeQuestionReceipt, TOPIC_QUIZ_QUESTION_TEXT, [TOPIC_QUIZ_CORRECT_OPTION]);
  const springOwnCheck = acceptedBySpring; // already Spring checking the (Node-issued, but content-identical) receipt above
  mismatches.push(
    ...compareStatusAndBody({ scenario, endpoint: 'POST /check (correct answer)', expectedNodeRes: nodeOwnCheck, actualSpringRes: springOwnCheck }),
    // Independent: a validly-issued receipt with a correct answer MUST
    // resolve (200) on each side.
    ...assertRuntimeStatus({
      scenario,
      endpoint: 'POST /check (correct answer)',
      nodeStatus: nodeOwnCheck.status,
      springStatus: springOwnCheck.status,
      isAcceptable: (status) => status === 200,
      labelA: 'Node',
      labelB: 'Spring'
    })
  );

  // (d) missing / malformed / tampered receipts — equivalent error contracts.
  const errorCases = [
    { label: 'missing receipt', headers: {} },
    { label: 'malformed receipt', headers: { 'X-Question-Receipt': 'not-a-real-receipt' } },
    {
      label: 'tampered receipt (flipped signature char)',
      headers: { 'X-Question-Receipt': tamperReceipt(nodeQuestionReceipt) }
    }
  ];
  for (const { label, headers } of errorCases) {
    const [nodeErr, springErr] = await Promise.all([
      request(nodeBase, 'POST', `/api/quizzes/${TOPIC_QUIZ_ID}/check`, {
        headers: { ...headers, 'content-type': 'application/json' },
        body: { questionText: TOPIC_QUIZ_QUESTION_TEXT, selectedOptionTexts: [TOPIC_QUIZ_CORRECT_OPTION] }
      }),
      request(springBase, 'POST', `/api/quizzes/${TOPIC_QUIZ_ID}/check`, {
        headers: { ...headers, 'content-type': 'application/json' },
        body: { questionText: TOPIC_QUIZ_QUESTION_TEXT, selectedOptionTexts: [TOPIC_QUIZ_CORRECT_OPTION] }
      })
    ]);
    mismatches.push(
      ...compareStatusAndBody({ scenario, endpoint: `POST /check (${label})`, expectedNodeRes: nodeErr, actualSpringRes: springErr }),
      // Independent of whether the two runtimes agree: an invalid receipt
      // MUST be rejected (401) on each side — a shared "both accept it"
      // regression must not hide behind a clean cross-runtime diff.
      ...assertRuntimeStatus({
        scenario,
        endpoint: `POST /check (${label})`,
        nodeStatus: nodeErr.status,
        springStatus: springErr.status,
        isAcceptable: (status) => status === 401,
        labelA: 'Node',
        labelB: 'Spring'
      })
    );
  }

  // (e) incorrect answer, for shape completeness on the resolved-and-wrong path.
  const nodeWrong = await checkAnswer(nodeBase, TOPIC_QUIZ_ID, nodeQuestionReceipt, TOPIC_QUIZ_QUESTION_TEXT, [TOPIC_QUIZ_WRONG_OPTION]);
  const springWrongReceipt = await issueQuestionReceipt(springBase, TOPIC_QUIZ_ID, await issueAttemptReceipt(springBase, TOPIC_QUIZ_ID), TOPIC_QUIZ_QUESTION_TEXT);
  const springWrong = await checkAnswer(springBase, TOPIC_QUIZ_ID, springWrongReceipt, TOPIC_QUIZ_QUESTION_TEXT, [TOPIC_QUIZ_WRONG_OPTION]);
  mismatches.push(
    ...compareStatusAndBody({ scenario, endpoint: 'POST /check (wrong answer)', expectedNodeRes: nodeWrong, actualSpringRes: springWrong }),
    // Independent: a wrong-but-authorized answer is still a resolved check
    // (200, correct:false) on each side, never an error.
    ...assertRuntimeStatus({
      scenario,
      endpoint: 'POST /check (wrong answer)',
      nodeStatus: nodeWrong.status,
      springStatus: springWrong.status,
      isAcceptable: (status) => status === 200,
      labelA: 'Node',
      labelB: 'Spring'
    })
  );

  return { scenario, mismatches, notes };
}

function tamperReceipt(receipt) {
  const parts = receipt.split('.');
  const sig = parts[1] ?? '';
  const flipped = sig.length > 0 ? (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1) : 'AAAA';
  return [parts[0], flipped].join('.');
}

// findForbiddenKeyPaths/FORBIDDEN_ANSWER_KEYS are used only internally
// above — not exported, since nothing outside this file needs them.
module.exports = {
  TOPIC_QUIZ_ID,
  INTERVIEW_TOPIC_ID,
  INTERVIEW_QUESTION_COUNT,
  runMetadataScenario,
  runTopicQuizScenario
};
