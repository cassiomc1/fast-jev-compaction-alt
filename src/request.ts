import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

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
  if (!(name in answers)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  const answer = answers[name];
  if (
    !answer ||
    typeof answer !== 'object' ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

/** Validates that all questions have matching, valid answers. */
export function validateAnswers(
  questions: JevQuestions,
  answers: Record<string, JevAnswer>,
): void {
  for (const name of Object.keys(questions)) {
    const q = questions[name];
    if (q?.type === 'noul') {
      noulAnswer(answers, name);
    } else if (!(name in answers)) {
      throw new Error(`Jev response missing answer for ${name}`);
    }
  }
}
