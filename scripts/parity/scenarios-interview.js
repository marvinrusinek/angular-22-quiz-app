'use strict';

const { request } = require('./lib/client');
const { compareResponses, compareStatusAndBody, assertRuntimeStatus } = require('./lib/compare');
const { INTERVIEW_TOPIC_ID, INTERVIEW_QUESTION_COUNT } = require('./scenarios');

/** questionText -> array of correct option texts, read from the SAME fixture
 *  the disposable database was seeded from — not from either runtime's own
 *  response (which never reveals correctness before submit, by design). */
function buildCorrectAnswerMap(fixture, quizId) {
  const quiz = fixture.quizzes.find((q) => q.quizId === quizId);
  const map = new Map();
  for (const q of quiz.questions) {
    map.set(q.questionText, q.options.filter((o) => o.correct).map((o) => o.text));
  }
  return map;
}

async function createSession(base) {
  return request(base, 'POST', '/api/interview-sessions', {
    headers: { 'content-type': 'application/json' },
    // difficulty: 'mixed' bypasses the topic/difficulty match check entirely
    // (custom mode still requires SOME difficulty value) — irrelevant here
    // since INTERVIEW_TOPIC_ID is requested by id, not filtered by difficulty.
    body: { mode: 'custom', topicIds: [INTERVIEW_TOPIC_ID], questionCount: INTERVIEW_QUESTION_COUNT, difficulty: 'mixed' }
  });
}
async function resumeSession(base, sessionId, token) {
  return request(base, 'GET', `/api/interview-sessions/${sessionId}`, { headers: { authorization: `Bearer ${token}` } });
}
async function answerQuestion(base, sessionId, questionId, token, selectedOptionIds) {
  return request(base, 'PUT', `/api/interview-sessions/${sessionId}/answers/${questionId}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: { selectedOptionIds }
  });
}
async function flagQuestion(base, sessionId, questionId, token, flagged) {
  return request(base, 'PUT', `/api/interview-sessions/${sessionId}/review/${questionId}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: { flagged }
  });
}
async function submitSession(base, sessionId, token) {
  return request(base, 'POST', `/api/interview-sessions/${sessionId}/submit`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: {}
  });
}
async function getResult(base, sessionId, token) {
  return request(base, 'GET', `/api/interview-sessions/${sessionId}/result`, { headers: { authorization: `Bearer ${token}` } });
}

/** Runs one full create -> resume -> answer -> flag -> submit lifecycle,
 *  split across the two runtimes, and returns the frozen result body plus
 *  every mismatch/note found along the way. */
async function runFullLifecycle({ createBase, operateBase, correctByQuestionText, directionLabel }) {
  const scenario = `Interview Mode lifecycle (${directionLabel})`;
  const mismatches = [];
  const notes = [];

  const created = await createSession(createBase);
  if (created.status !== 201) throw new Error(`${directionLabel}: create failed, status=${created.status} body=${JSON.stringify(created.body)}`);
  const { sessionId, sessionToken, questions } = created.body;
  notes.push(`${directionLabel}: created session ${sessionId} with ${questions.length} questions`);

  // Resume through the OTHER runtime — proves it can read what the first
  // runtime wrote to the shared database. `remainingSeconds` is excluded: it
  // is recomputed from wall-clock time on every call by design, so a few
  // hundred ms of real elapsed time between create and resume legitimately
  // changes it — that is not a parity bug.
  const resumed = await resumeSession(operateBase, sessionId, sessionToken);
  if (resumed.status !== 200) {
    mismatches.push({ endpoint: `GET resume (${directionLabel})`, path: '$.status', expected: 200, actual: resumed.status });
  } else {
    const { sessionToken: _drop, ...createdWithoutToken } = created.body;
    mismatches.push(
      ...compareResponses({
        scenario,
        endpoint: `create vs resume (${directionLabel})`,
        expectedNode: createdWithoutToken,
        actualSpring: resumed.body,
        ignorePaths: [/\.remainingSeconds$/]
      })
    );
  }

  // Which question gets answered wrong, and which gets flagged, must be
  // chosen by a STABLE key (questionText) — NOT by position in `questions`,
  // which is independently shuffled per session. Two sessions requesting the
  // identical topic/count still see the SAME 10 questions in a DIFFERENT
  // order, so an index-based choice ("the first one", "the last one") would
  // land on a different actual question in each direction, breaking the
  // cross-direction equivalence check below for no real reason.
  const byQuestionTextAsc = [...questions].sort((a, b) => a.questionText.localeCompare(b.questionText));
  const wrongQuestionText = byQuestionTextAsc[0].questionText;
  const flaggedQuestionText = byQuestionTextAsc[byQuestionTextAsc.length - 1].questionText;

  // Answer every question: all correct except `wrongQuestionText`, answered
  // wrong on purpose, for a deterministic (questionCount - 1) / questionCount
  // score both directions can be compared against.
  for (const [index, q] of questions.entries()) {
    const correctTexts = correctByQuestionText.get(q.questionText) ?? [];
    const optionByText = new Map(q.options.map((o) => [o.text, o.optionId]));
    const wantWrong = q.questionText === wrongQuestionText;
    const chosenTexts = wantWrong
      ? [q.options.find((o) => !correctTexts.includes(o.text))?.text].filter(Boolean)
      : correctTexts;
    const selectedOptionIds = chosenTexts.map((t) => optionByText.get(t)).filter((id) => id !== undefined);

    const answered = await answerQuestion(operateBase, sessionId, q.questionId, sessionToken, selectedOptionIds);
    if (answered.status !== 200 || answered.body?.saved !== true) {
      mismatches.push({ endpoint: `PUT answers (${directionLabel}, q${index})`, path: '$.status/$.saved', expected: '200/true', actual: `${answered.status}/${answered.body?.saved}` });
    }
  }

  // Flag `flaggedQuestionText` for review (same stable-key reasoning as above).
  const lastQuestion = questions.find((q) => q.questionText === flaggedQuestionText);
  const flagged = await flagQuestion(operateBase, sessionId, lastQuestion.questionId, sessionToken, true);
  if (flagged.status !== 200 || flagged.body?.flagged !== true) {
    mismatches.push({ endpoint: `PUT review (${directionLabel})`, path: '$.status/$.flagged', expected: '200/true', actual: `${flagged.status}/${flagged.body?.flagged}` });
  }

  const submitted = await submitSession(operateBase, sessionId, sessionToken);
  if (submitted.status !== 200) {
    throw new Error(`${directionLabel}: submit failed, status=${submitted.status} body=${JSON.stringify(submitted.body)}`);
  }
  notes.push(`${directionLabel}: submitted — score ${submitted.body.correct}/${submitted.body.total} (${submitted.body.percentage}%)`);

  // Idempotent resubmission — through BOTH runtimes: the runtime that just
  // submitted, and the OTHER one (the shared-DB idempotency guarantee must
  // hold regardless of which runtime's code path re-triggers it).
  const resubmitSame = await submitSession(operateBase, sessionId, sessionToken);
  mismatches.push(
    ...compareStatusAndBody({
      scenario,
      endpoint: `resubmit same runtime (${directionLabel})`,
      expectedNodeRes: { status: 200, body: submitted.body }, // idempotent: must be 200, byte-identical to the original
      actualSpringRes: resubmitSame
    })
  );
  const resubmitOther = await submitSession(createBase, sessionId, sessionToken);
  mismatches.push(
    ...compareStatusAndBody({
      scenario,
      endpoint: `resubmit other runtime (${directionLabel})`,
      expectedNodeRes: { status: 200, body: submitted.body },
      actualSpringRes: resubmitOther
    })
  );

  // Post-submit mutation must be rejected consistently, on BOTH runtimes.
  const mutateAfterSubmitOperate = await answerQuestion(operateBase, sessionId, lastQuestion.questionId, sessionToken, []);
  const mutateAfterSubmitCreate = await answerQuestion(createBase, sessionId, lastQuestion.questionId, sessionToken, []);
  mismatches.push(
    ...compareStatusAndBody({ scenario, endpoint: `post-submit mutation rejected (${directionLabel})`, expectedNodeRes: mutateAfterSubmitOperate, actualSpringRes: mutateAfterSubmitCreate }),
    // Independent, on BOTH sides: both runtimes silently accepting the
    // mutation would still "match" a plain cross-diff.
    ...assertRuntimeStatus({
      scenario,
      endpoint: `post-submit mutation rejected (${directionLabel})`,
      nodeStatus: mutateAfterSubmitOperate.status,
      springStatus: mutateAfterSubmitCreate.status,
      isAcceptable: (status) => status >= 400,
      labelA: 'operate-side runtime',
      labelB: 'create-side runtime'
    })
  );

  // Same session, read back through BOTH runtimes — must be byte-identical
  // (it is the one frozen row, not two independently-generated sessions).
  const resultViaOperate = await getResult(operateBase, sessionId, sessionToken);
  const resultViaCreate = await getResult(createBase, sessionId, sessionToken);
  mismatches.push(
    ...compareStatusAndBody({ scenario, endpoint: `GET result via both runtimes (${directionLabel})`, expectedNodeRes: resultViaCreate, actualSpringRes: resultViaOperate })
  );

  return { sessionId, result: submitted.body, mismatches, notes };
}

/** Turns a frozen result into an ID-agnostic, order-agnostic canonical shape
 *  so two INDEPENDENTLY-CREATED sessions (different random topic/question/
 *  option shuffles, different generated ids, different timestamps) can be
 *  compared for genuine semantic equivalence. Every field dropped or
 *  transformed here is listed with why in the comments below. */
function canonicalizeResult(resultBody) {
  const optionTextsById = (options) => new Map(options.map((o) => [o.optionId, o.text]));

  const review = [...(resultBody.review ?? [])]
    .map((r) => {
      const byId = optionTextsById(r.options ?? []);
      const toTexts = (ids) => [...(ids ?? [])].map((id) => byId.get(id) ?? `<unknown:${id}>`).sort();
      return {
        questionText: r.questionText,
        type: r.type,
        optionTexts: [...(r.options ?? [])].map((o) => o.text).sort(),
        selectedOptionTexts: toTexts(r.selectedOptionIds),
        correctOptionTexts: toTexts(r.correctOptionIds),
        explanation: r.explanation,
        flagged: r.flagged
      };
    })
    .sort((a, b) => a.questionText.localeCompare(b.questionText));

  const byTopic = [...(resultBody.performance?.byTopic ?? [])]
    .map((t) => ({ topicId: t.topicId, correct: t.correct, incorrect: t.incorrect, unanswered: t.unanswered, total: t.total, percentage: t.percentage }))
    .sort((a, b) => a.topicId.localeCompare(b.topicId));

  return {
    status: resultBody.status,
    submittedByExpiry: resultBody.submittedByExpiry,
    total: resultBody.total,
    answered: resultBody.answered,
    unanswered: resultBody.unanswered,
    correct: resultBody.correct,
    incorrect: resultBody.incorrect,
    percentage: resultBody.percentage,
    durationSeconds: resultBody.durationSeconds,
    config: {
      mode: resultBody.config?.mode,
      topicIds: [...(resultBody.config?.topicIds ?? [])].sort(),
      questionCount: resultBody.config?.questionCount
    },
    performance: { byTopic },
    review
    // Dropped entirely (genuinely volatile, not content): sessionId,
    // sessionToken, submittedAt, timeUsedSeconds, timeRemainingSeconds,
    // every questionId/optionId (session-scoped, meaningless across two
    // independently-created sessions — semantic identity is carried by
    // questionText/option text instead, per the transform above).
  };
}

async function runBadBearerScenario({ nodeBase, springBase }) {
  const scenario = 'Interview Mode — missing/wrong bearer token error contract';
  const mismatches = [];
  const fakeSessionId = 'is_0000000000000000000000';

  const cases = [
    { label: 'missing Authorization header', headers: {} },
    { label: 'malformed bearer token', headers: { authorization: 'Bearer not-a-real-token' } }
  ];

  for (const { label, headers } of cases) {
    const [nodeRes, springRes] = await Promise.all([
      request(nodeBase, 'GET', `/api/interview-sessions/${fakeSessionId}/result`, { headers }),
      request(springBase, 'GET', `/api/interview-sessions/${fakeSessionId}/result`, { headers })
    ]);
    mismatches.push(
      ...compareStatusAndBody({ scenario, endpoint: `GET result (${label})`, expectedNodeRes: nodeRes, actualSpringRes: springRes }),
      // Independent: a missing/wrong bearer MUST be rejected (401) on each
      // side — both runtimes silently authorizing it would still "match".
      ...assertRuntimeStatus({
        scenario,
        endpoint: `GET result (${label})`,
        nodeStatus: nodeRes.status,
        springStatus: springRes.status,
        isAcceptable: (status) => status === 401,
        labelA: 'Node',
        labelB: 'Spring'
      })
    );
  }

  return { scenario, mismatches, notes: [] };
}

async function runInterviewScenario({ nodeBase, springBase, fixture }) {
  const scenario = 'Interview Mode parity (cross-runtime lifecycle + submitted-result equivalence)';
  const correctByQuestionText = buildCorrectAnswerMap(fixture, INTERVIEW_TOPIC_ID);
  const allMismatches = [];
  const allNotes = [];

  const directionA = await runFullLifecycle({
    createBase: nodeBase,
    operateBase: springBase,
    correctByQuestionText,
    directionLabel: 'created-by-Node-operated-by-Spring'
  });
  allMismatches.push(...directionA.mismatches);
  allNotes.push(...directionA.notes);

  const directionB = await runFullLifecycle({
    createBase: springBase,
    operateBase: nodeBase,
    correctByQuestionText,
    directionLabel: 'created-by-Spring-operated-by-Node'
  });
  allMismatches.push(...directionB.mismatches);
  allNotes.push(...directionB.notes);

  const canonA = canonicalizeResult(directionA.result);
  const canonB = canonicalizeResult(directionB.result);
  allMismatches.push(
    ...compareResponses({
      scenario,
      endpoint: 'Cross-direction submitted-result equivalence (canonicalized)',
      expectedNode: canonA,
      actualSpring: canonB
    })
  );

  const badBearer = await runBadBearerScenario({ nodeBase, springBase });
  allMismatches.push(...badBearer.mismatches);

  return { scenario, mismatches: allMismatches, notes: allNotes };
}

module.exports = { runInterviewScenario };
