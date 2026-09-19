import { describe, expect, it } from 'vitest';

import { askQuestions, validateAnswers } from '../src/request.js';
import type { JevQuestions } from '../src/types.js';

const questions: JevQuestions = {
  intent: {
    type: 'choice',
    instructions: 'Classify the requested action.',
    criteria: { read_only: 'No mutation', mutate: 'Changes state' },
  },
  urgency: {
    type: 'score',
    instructions: 'Score urgency from the model-defined scale.',
    criteria: ['low', 'high'],
  },
};

const validAnswers = {
  intent: {
    type: 'choice' as const,
    choice: 'read_only',
    confidence: 0.92,
    probabilities: { read_only: 0.92, mutate: 0.08 },
  },
  urgency: {
    type: 'score' as const,
    score: 0.4,
    confidence: 0.8,
    probabilities: { low: 0.6, high: 0.4 },
  },
};

describe('Jev answer validation', () => {
  it('validates choice and score answers', () => {
    expect(() => validateAnswers(questions, validAnswers)).not.toThrow();
  });

  it('rejects unknown choices, invalid confidence, and non-finite scores', () => {
    expect(() => validateAnswers(questions, {
      ...validAnswers,
      intent: { ...validAnswers.intent, choice: 'unknown' },
    })).toThrow(/choice/);
    expect(() => validateAnswers(questions, {
      ...validAnswers,
      intent: { ...validAnswers.intent, confidence: 1.1 },
    })).toThrow(/probability/);
    expect(() => validateAnswers(questions, {
      ...validAnswers,
      urgency: { ...validAnswers.urgency, score: Number.NaN },
    })).toThrow(/score/);
  });

  it('validates generic asker responses before returning them', async () => {
    const response = await askQuestions(
      {
        ask: async () => ({ answers: validAnswers }),
      },
      { task: 'classify' },
      questions,
    );
    expect(response.answers.intent).toMatchObject({ choice: 'read_only' });
  });
});

