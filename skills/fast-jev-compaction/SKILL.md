---
name: fast-jev-compaction
description: "Apply Jev-guided, verbatim context compaction and fail-closed decision support to programming tasks, including intent routing, triage, urgency, risk, autonomy thresholds, and parallel question evaluation."
---

# Fast Jev Compaction

Use this skill by default when a session involves programming work, a long
tool-heavy transcript, intent routing, triage, urgency, risk, autonomous
actions, or several independent questions.

## Operating rules

1. Keep the local policy as the authorization boundary. Jev can provide
   probabilities and evidence, but it must never grant permission by itself.
2. Fail closed for autonomous actions when the intent is invalid, not on the
   explicit allow-list, below the confidence threshold, or missing/invalid
   required risk evidence.
3. Preserve user constraints, exact errors, commands, paths, test output, and
   tool-call IDs verbatim whenever they remain relevant. Do not replace them
   with an invented summary.
4. Treat unknown host fields and opaque IDs as data. Do not normalize or
   rewrite them unless the host adapter explicitly requires it.
5. Run independent Jev questions in bounded parallel batches when the host
   integration supports it. Validate every answer before using it.
6. If the TypeSafe key is missing, the network fails, or Jev returns malformed
   data, continue with the host's normal fallback. Never block a coding task
   just because optional Jev guidance is unavailable.

## TypeScript integration

When the package is available, prefer the public APIs instead of reimplementing
the policy:

- `compactCodexItems` and `applyDecisionsToCodex` for Responses/Codex item
  arrays;
- `codexToMessages` when a structural Codex transcript must be inspected;
- `askQuestions` for validated `choice`, `score`, or `noul` questions;
- `evaluateAutonomy` for the local allow-list, confidence, and risk gate.

The package is dependency-light and does not require an OpenAI or Codex SDK.
Use `fast-jev-compaction-alt/codex` for the Responses adapter and import the
other helpers from the package root.

## Safe decision sequence

For a request that might be acted on autonomously:

1. Classify the intent and collect confidence.
2. Collect urgency and risk when the action could affect code, data, external
   systems, credentials, or other people.
3. Apply `evaluateAutonomy` with an explicit allow-list and thresholds.
4. If the decision is not allowed, ask for clarification or approval; do not
   silently widen the allow-list.
5. Keep normal repository, test, review, and approval gates in place.

## Compaction boundary

This plugin provides a reusable skill and library adapter. It does not claim
to intercept or rewrite Codex's private hidden context window. Use the Codex
adapter when a host integration supplies a Responses-style item list, and
leave the original payload untouched when Jev fails or the result is not
useful enough.

For repository changes, run the focused programming tests first and then the
project's complete validation gate. Never send `TYPESAFE_API_KEY` to logs or
commit it to the repository.
