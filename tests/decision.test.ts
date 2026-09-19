import { describe, expect, it } from 'vitest';

import { evaluateAutonomy } from '../src/decision.js';

const policy = {
  allowedIntents: ['read_only', 'format_code'],
  minConfidence: 0.8,
  maxRisk: 0.3,
} as const;

describe('evaluateAutonomy', () => {
  it('allows only an approved intent with sufficient confidence and low risk', () => {
    expect(
      evaluateAutonomy(
        {
          intent: { choice: 'format_code', confidence: 0.9, probabilities: {} },
          risk: { score: 0.1, confidence: 0.9, probabilities: {} },
        },
        policy,
      ),
    ).toMatchObject({ allowed: true, reason: 'allowed' });
  });

  it('fails closed for unknown intents, low confidence, missing risk, and high risk', () => {
    expect(
      evaluateAutonomy(
        { intent: { choice: 'delete_data', confidence: 0.99, probabilities: {} }, risk: { score: 0.1, confidence: 1, probabilities: {} } },
        policy,
      ).reason,
    ).toBe('intent_not_allowed');
    expect(
      evaluateAutonomy(
        { intent: { choice: 'format_code', confidence: 0.79, probabilities: {} }, risk: { score: 0.1, confidence: 1, probabilities: {} } },
        policy,
      ).reason,
    ).toBe('low_confidence');
    expect(
      evaluateAutonomy(
        { intent: { choice: 'format_code', confidence: 0.9, probabilities: {} } },
        policy,
      ).reason,
    ).toBe('missing_risk');
    expect(
      evaluateAutonomy(
        { intent: { choice: 'format_code', confidence: 0.9, probabilities: {} }, risk: { score: 0.31, confidence: 1, probabilities: {} } },
        policy,
      ).reason,
    ).toBe('high_risk');
  });

  it('rejects an invalid policy instead of authorizing', () => {
    expect(
      evaluateAutonomy(
        { intent: { choice: 'format_code', confidence: 1, probabilities: {} } },
        { allowedIntents: [], minConfidence: 0.8 },
      ),
    ).toMatchObject({ allowed: false, reason: 'invalid_policy' });
  });

  it('rejects a risk score outside the declared 0..1 policy scale', () => {
    expect(
      evaluateAutonomy(
        { intent: { choice: 'format_code', confidence: 1, probabilities: {} }, risk: { score: -0.1, confidence: 1, probabilities: {} } },
        policy,
      ),
    ).toMatchObject({ allowed: false, reason: 'invalid_risk' });
  });
});
