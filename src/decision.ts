import type { ChoiceAnswer, ScoreAnswer } from './types.js';

export interface AutonomyPolicy {
  /** Intents that are safe to execute without an additional approval step. */
  allowedIntents: readonly string[];
  /** Minimum Jev confidence for the selected intent. */
  minConfidence: number;
  /** Optional maximum risk score. Risk is interpreted as higher = riskier. */
  maxRisk?: number;
}

export interface AutonomyEvidence {
  intent: ChoiceAnswer;
  risk?: ScoreAnswer;
}

export type AutonomyReason =
  | 'allowed'
  | 'invalid_policy'
  | 'invalid_intent'
  | 'intent_not_allowed'
  | 'low_confidence'
  | 'missing_risk'
  | 'invalid_risk'
  | 'high_risk';

export interface AutonomyDecision {
  allowed: boolean;
  reason: AutonomyReason;
  intent?: string;
  confidence?: number;
  risk?: number;
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Applies a local, fail-closed policy to Jev's intent and risk evidence.
 * Jev recommends; this function is the authorization boundary.
 */
export function evaluateAutonomy(
  evidence: AutonomyEvidence,
  policy: AutonomyPolicy,
): AutonomyDecision {
  if (
    policy.allowedIntents.length === 0 ||
    !validUnit(policy.minConfidence) ||
    (policy.maxRisk !== undefined && !validUnit(policy.maxRisk))
  ) {
    return { allowed: false, reason: 'invalid_policy' };
  }

  const { intent, risk } = evidence;
  const base = { intent: intent?.choice, confidence: intent?.confidence, risk: risk?.score };
  if (!intent || typeof intent.choice !== 'string' || !validUnit(intent.confidence)) {
    return { ...base, allowed: false, reason: 'invalid_intent' };
  }
  if (!policy.allowedIntents.includes(intent.choice)) {
    return { ...base, allowed: false, reason: 'intent_not_allowed' };
  }
  if (intent.confidence < policy.minConfidence) {
    return { ...base, allowed: false, reason: 'low_confidence' };
  }
  if (policy.maxRisk !== undefined) {
    if (!risk || !Number.isFinite(risk.score)) {
      return { ...base, allowed: false, reason: 'missing_risk' };
    }
    if (!validUnit(risk.score)) {
      return { ...base, allowed: false, reason: 'invalid_risk' };
    }
    if (risk.score > policy.maxRisk) {
      return { ...base, allowed: false, reason: 'high_risk' };
    }
  }
  return { ...base, allowed: true, reason: 'allowed' };
}
