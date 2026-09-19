import type {
  ChoiceAnswer,
  JevAnswer,
  JevQuestion,
  JevQuestions,
  JevResponse,
  JevState,
  NoulAnswer,
  ScoreAnswer,
} from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object' ||
    Array.isArray(parsed.answers)
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is missing or outside [0, 1]. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  if (!hasOwn(answers, name)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  const answer = answers[name];
  const value = answer && typeof answer === 'object'
    ? (answer as unknown as Record<string, unknown>).noul
    : undefined;
  if (
    !answer ||
    typeof answer !== 'object' ||
    !hasOwn(answer, 'noul') ||
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid Jev probability for ${label}`);
  }
  return value;
}

function validateProbabilityMap(value: unknown, label: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`Invalid Jev probabilities for ${label}`);
  for (const [key, probabilityValue] of Object.entries(value)) {
    probability(probabilityValue, `${label}.${key}`);
  }
  return value as Record<string, number>;
}

function validateChoiceAnswer(
  question: Extract<JevQuestion, { type: 'choice' }>,
  answer: unknown,
  name: string,
): asserts answer is ChoiceAnswer {
  if (!isRecord(answer) || typeof answer.choice !== 'string' || !hasOwn(question.criteria, answer.choice)) {
    throw new Error(`Invalid Jev choice answer for ${name}`);
  }
  probability(answer.confidence, `${name}.confidence`);
  validateProbabilityMap(answer.probabilities, name);
}

function validateScoreAnswer(
  answer: unknown,
  name: string,
): asserts answer is ScoreAnswer {
  if (!isRecord(answer) || typeof answer.score !== 'number' || !Number.isFinite(answer.score)) {
    throw new Error(`Invalid Jev score answer for ${name}`);
  }
  probability(answer.confidence, `${name}.confidence`);
  validateProbabilityMap(answer.probabilities, name);
}

/** Validates one answer against its question, including confidence fields. */
export function validateAnswer(
  question: JevQuestion,
  answer: unknown,
  name: string,
): asserts answer is JevAnswer {
  if (!isRecord(answer)) throw new Error(`Invalid Jev answer for ${name}`);
  if (answer.type !== undefined && answer.type !== question.type) {
    throw new Error(`Invalid Jev answer type for ${name}`);
  }
  if (question.type === 'noul') {
    if (!hasOwn(answer, 'noul')) throw new Error(`Invalid Jev answer for ${name}`);
    probability(answer.noul, name);
    return;
  }
  if (question.type === 'choice') {
    validateChoiceAnswer(question, answer, name);
    return;
  }
  validateScoreAnswer(answer, name);
}

/** Validates that all questions have matching, well-formed answers. */
export function validateAnswers(
  questions: JevQuestions,
  answers: Record<string, JevAnswer>,
): void {
  if (!isRecord(answers)) throw new Error('Jev response answers must be an object');
  for (const name of Object.keys(questions)) {
    const q = questions[name];
    if (!q || !hasOwn(answers, name)) {
      throw new Error(`Jev response missing answer for ${name}`);
    }
    validateAnswer(q, answers[name], name);
  }
}

/** Runs a generic, validated Jev query for routers, triage, or policy code. */
export async function askQuestions(
  asker: { ask(state: JevState, questions: JevQuestions): Promise<JevResponse> },
  state: JevState,
  questions: JevQuestions,
): Promise<JevResponse> {
  const response = await asker.ask(state, questions);
  validateAnswers(questions, response.answers);
  return response;
}
