import { tool } from '@opencode-ai/plugin';
import type { Plugin } from '@opencode-ai/plugin';

import { JevClient } from './client.js';
import { compact, decideCall, reductionRatio } from './compact.js';
import { collectToolCalls } from './state.js';
import {
  applyDecisionsToOpenCode,
  COMPACTION_FALLBACK_GUIDANCE,
  COMPACTION_VERBATIM_GUIDANCE,
  compactionContext,
  decisionLog,
  decisionSummary,
  isTestCommand,
  lookupToolWeight,
  openCodeToMessages,
  pruningSystemGuidance,
  resolveOpenCodeConfig,
  type ApplyToOpenCodeStats,
  type OpenCodeMessageWithParts,
  type OpenCodePluginOptions,
} from './opencode.js';
import type { CallAnswer, CallDecision, CompactOptions, CompactResult } from './types.js';

const SERVICE = 'fast-jev-compaction';

/** TypeSafe rejects the key: retrying on every request would only add latency. */
function isAuthError(error: unknown): boolean {
  return error instanceof Error && /Jev request failed \((401|403)\)/.test(error.message);
}

type AppLog = (input: {
  body: {
    service: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    extra?: Record<string, unknown>;
  };
}) => Promise<unknown>;

function compactOptionsOf(config: {
  goal?: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}): CompactOptions {
  return {
    goal: config.goal,
    keepThreshold: config.keepThreshold,
    preserveRecentMessages: config.preserveRecentMessages,
    maxStateTokens: config.maxStateTokens,
    maxRequestTokens: config.maxRequestTokens,
    truncateHeadChars: config.truncateHeadChars,
  };
}

/**
 * Appends one stats-only JSON line (no message content) to the debug file
 * when configured. Failures are silent: diagnostics must never break a
 * session. Works on Bun and Node (`node:fs`).
 */
async function debugLine(debugFile: string | undefined, line: Record<string, unknown>): Promise<void> {
  if (!debugFile) return;
  try {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(debugFile, `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);
  } catch {
    // Diagnostics must never break a session.
  }
}

/**
 * OpenCode plugin: continuous, verbatim Jev-guided context pruning.
 *
 * - `experimental.chat.messages.transform` runs the library over the messages
 *   of every LLM request (normal prompts and compactions alike) and drops or
 *   truncates the tool outputs Jev judges stale. The stored session is never
 *   rewritten; only the in-memory copy sent to the model is pruned.
 * - `experimental.session.compacting` injects the Jev keep/drop lists into the
 *   built-in compaction prompt so the summary preserves what still matters.
 *
 * Configure via plugin options (`["fast-jev-compaction", { ... }]`) or
 * `TYPESAFE_API_KEY` in the environment. All failures are logged and leave
 * the messages untouched, so the session always keeps working.
 */
export const FastJevCompactionPlugin: Plugin = async ({ client }, options) => {
  const config = resolveOpenCodeConfig(
    (options ?? {}) as OpenCodePluginOptions,
    typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {},
  );
  const log: AppLog = async (input) => {
    try {
      await client.app.log(input);
    } catch {
      // Logging must never break a session.
    }
  };
  // Set once TypeSafe rejects the key: the key is fixed for the plugin's
  // lifetime, so further Jev round-trips would only add latency to every
  // request. Transient failures (5xx, timeouts) never set this.
  let authFailed = false;

  // --- Run history and cumulative stats ---
  const MAX_HISTORY = 5;
  const runHistory: Record<string, unknown>[] = [];
  const cumulativeStats = {
    runs: 0,
    partsDropped: 0,
    partsTruncated: 0,
    messagesDropped: 0,
    tokensSaved: 0,
  };

  // System guidance lines from the last transform, consumed by the system
  // prompt hook on the same request cycle.
  let lastPruneGuidance: string[] = [];
  // The last CompactResult, kept for the system prompt hook.
  let lastCompactResult: CompactResult | null = null;

  const statusSnapshot = (): string =>
    JSON.stringify(
      {
        plugin: 'fast-jev-compaction',
        enabled: config.enabled,
        model: config.model,
        keepThreshold: config.keepThreshold,
        preserveRecentMessages: config.preserveRecentMessages,
        maxStateTokens: config.maxStateTokens,
        maxRequestTokens: config.maxRequestTokens,
        truncateHeadChars: config.truncateHeadChars,
        minReductionRatio: config.minReductionRatio,
        toolWeights: config.toolWeights,
        key: config.apiKey ? 'configured' : 'missing',
        authFailed,
        lastRun: runHistory[runHistory.length - 1] ?? null,
        runHistory,
        cumulativeStats,
      },
      null,
      2,
    );

  /** Records the latest run for the status tool and mirrors it to the debug file. */
  const note = async (run: Record<string, unknown>): Promise<void> => {
    runHistory.push(run);
    if (runHistory.length > MAX_HISTORY) runHistory.shift();
    cumulativeStats.runs += 1;
    await debugLine(config.debugFile, run);
  };

  await log({
    body: {
      service: SERVICE,
      level: 'debug',
      message: `loaded (model=${config.model}, keepThreshold=${config.keepThreshold}, preserveRecentMessages=${config.preserveRecentMessages}, minReductionRatio=${config.minReductionRatio}, enabled=${config.enabled}, key=${config.apiKey ? 'configured' : 'missing'})`,
    },
  });

  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      // Reset cross-hook state for this request cycle.
      lastPruneGuidance = [];
      lastCompactResult = null;
      try {
        if (!config.enabled) return;
        const messages = output.messages as unknown as OpenCodeMessageWithParts[];
        if (!Array.isArray(messages) || messages.length === 0) return;
        if (!config.apiKey) {
          await log({
            body: {
              service: SERVICE,
              level: 'debug',
              message: 'skipped: TYPESAFE_API_KEY is not configured',
            },
          });
          await note({ hook: 'transform', outcome: 'no-key' });
          return;
        }
        if (authFailed) {
          await log({
            body: {
              service: SERVICE,
              level: 'debug',
              message: 'skipped: TypeSafe key was rejected, Jev pruning disabled until reload',
            },
          });
          await note({ hook: 'transform', outcome: 'auth-disabled' });
          return;
        }

        // --- Test failure pinning ---
        // Find callIDs of test commands that ended with an error: these must
        // never be pruned because the agent needs the exact failure output.
        const testErrorCallIDs = new Set<string>();
        for (const entry of messages) {
          for (const part of entry.parts) {
            if (
              isTestCommand(part) &&
              part.state?.status === 'error' &&
              typeof part.callID === 'string'
            ) {
              testErrorCallIDs.add(part.callID);
            }
          }
        }

        const libMessages = openCodeToMessages(messages);
        const calls = collectToolCalls(libMessages, config.preserveRecentMessages);

        // Force-pin test-error calls so they are never candidates.
        for (const call of calls) {
          if (testErrorCallIDs.has(call.tool_use_id)) {
            call.pinned = true;
          }
        }

        const candidates = calls.filter((call) => !call.pinned);
        if (candidates.length === 0) {
          await note({
            hook: 'transform',
            outcome: 'no-candidates',
            messages: messages.length,
            calls: calls.length,
            testPinned: testErrorCallIDs.size,
          });
          return;
        }

        const asker = new JevClient({
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl,
        });
        const result = await compact(libMessages, asker, compactOptionsOf(config));

        // --- Tool weight bias ---
        // Adjust Jev scores per-tool before the threshold comparison, then
        // re-decide. This keeps the library's `compact()` unmodified while
        // giving heavier tools (shells, edits) a better chance of staying.
        const biasedDecisions: typeof result.decisions = result.decisions.map((d) => {
          if (d.reason === 'pinned') return d;
          const weight = lookupToolWeight(config.toolWeights, d.tool);
          const biasedCall = Math.min(1, d.keepCall + (weight.callBias ?? 0));
          const biasedResult = Math.min(1, d.keepResult + (weight.resultBias ?? 0));
          const call = calls.find((c) => c.id === d.id);
          return decideCall(
            call ?? { id: d.id, tool: d.tool, pinned: false },
            { keepCall: biasedCall, keepResult: biasedResult },
            { keepThreshold: config.keepThreshold },
          );
        });
        const biasedResult: CompactResult = { ...result, decisions: biasedDecisions };

        if (reductionRatio(biasedResult) < config.minReductionRatio) {
          await log({
            body: {
              service: SERVICE,
              level: 'debug',
              message: `skipped: below minReductionRatio (${decisionSummary(biasedResult)})`,
            },
          });
          await note({
            hook: 'transform',
            outcome: 'below-min-ratio',
            summary: decisionSummary(biasedResult),
          });
          return;
        }
        const stats: ApplyToOpenCodeStats = {
          partsDropped: 0,
          partsTruncated: 0,
          messagesDropped: 0,
        };
        const next = applyDecisionsToOpenCode(
          messages,
          biasedResult.decisions,
          calls,
          config.truncateHeadChars,
          stats,
        );
        if (
          stats.partsDropped === 0 &&
          stats.partsTruncated === 0 &&
          next.length === messages.length
        ) {
          await note({
            hook: 'transform',
            outcome: 'noop',
            summary: decisionSummary(biasedResult),
          });
          return;
        }
        // Mutate in place: reassigning `output.messages` is a silent no-op in
        // the OpenCode runtime, which keeps the original array reference.
        const messagesBefore = messages.length;
        (output.messages as unknown[]).splice(0, messages.length, ...(next as unknown[]));

        // Update cumulative stats.
        cumulativeStats.partsDropped += stats.partsDropped;
        cumulativeStats.partsTruncated += stats.partsTruncated;
        cumulativeStats.messagesDropped += stats.messagesDropped;
        cumulativeStats.tokensSaved += biasedResult.stats.charsBefore - biasedResult.stats.charsAfter;

        // Store for the system prompt hook.
        lastPruneGuidance = pruningSystemGuidance(biasedResult, stats);
        lastCompactResult = biasedResult;

        await note({
          hook: 'transform',
          outcome: 'pruned',
          messagesBefore,
          messagesAfter: next.length,
          partsDropped: stats.partsDropped,
          partsTruncated: stats.partsTruncated,
          messagesDropped: stats.messagesDropped,
          testPinned: testErrorCallIDs.size,
          summary: decisionSummary(biasedResult),
          decisions: decisionLog(biasedResult),
        });
        await log({
          body: {
            service: SERVICE,
            level: 'info',
            message: `pruned context sent to model (${decisionSummary(biasedResult)})`,
            extra: {
              partsDropped: stats.partsDropped,
              partsTruncated: stats.partsTruncated,
              messagesDropped: stats.messagesDropped,
              testPinned: testErrorCallIDs.size,
              decisions: decisionLog(biasedResult),
            },
          },
        });
      } catch (error) {
        if (isAuthError(error)) authFailed = true;
        await log({
          body: {
            service: SERVICE,
            level: 'warn',
            message: isAuthError(error)
              ? 'TypeSafe key rejected (401/403); Jev pruning disabled until OpenCode reloads'
              : `pruning skipped (${error instanceof Error ? error.message : String(error)})`,
          },
        });
      }
    },

    'experimental.chat.system.transform': async (_input, output) => {
      // Inject guidance when the transform hook pruned something on this
      // request cycle, so the assistant knows which tools were compacted.
      if (lastPruneGuidance.length > 0) {
        for (const line of lastPruneGuidance) {
          output.system.push(line);
        }
      }
    },

    'experimental.session.compacting': async (input, output) => {
      try {
        if (!config.enabled) return;
        if (!config.apiKey) {
          output.context.push(COMPACTION_FALLBACK_GUIDANCE);
          await log({
            body: {
              service: SERVICE,
              level: 'debug',
              message: 'compacting: TYPESAFE_API_KEY is not configured, pushed fallback guidance',
            },
          });
          return;
        }
        if (authFailed) {
          output.context.push(
            `${COMPACTION_FALLBACK_GUIDANCE} (TypeSafe key was rejected; Jev pruning disabled until reload)`,
          );
          return;
        }
        const response = await client.session.messages({ path: { id: input.sessionID } });
        const entries = (response as { data?: unknown }).data as
          | OpenCodeMessageWithParts[]
          | undefined;
        if (!Array.isArray(entries) || entries.length === 0) return;
        const libMessages = openCodeToMessages(entries);
        const calls = collectToolCalls(libMessages, config.preserveRecentMessages);
        if (calls.filter((call) => !call.pinned).length === 0) {
          output.context.push(COMPACTION_VERBATIM_GUIDANCE);
          return;
        }
        const asker = new JevClient({
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl,
        });
        const result = await compact(libMessages, asker, compactOptionsOf(config));
        for (const line of compactionContext(result)) output.context.push(line);
        await note({
          hook: 'compacting',
          outcome: 'guidance',
          sessionID: input.sessionID,
          contextLines: output.context.length,
          summary: decisionSummary(result),
          decisions: decisionLog(result),
        });
        await log({
          body: {
            service: SERVICE,
            level: 'info',
            message: `compacting guidance injected (${decisionSummary(result)})`,
            extra: { decisions: decisionLog(result) },
          },
        });
      } catch (error) {
        if (isAuthError(error)) authFailed = true;
        output.context.push(`${COMPACTION_FALLBACK_GUIDANCE} (${error instanceof Error ? error.message : String(error)})`);
        await log({
          body: {
            service: SERVICE,
            level: 'warn',
            message: `compacting guidance fell back (${error instanceof Error ? error.message : String(error)})`,
          },
        });
      }
    },

    tool: {
      jev_compaction_status: tool({
        description:
          'Check whether fast-jev-compaction (Jev-guided verbatim context pruning) is active in this session. Returns the plugin configuration, tool weight biases, the last 5 pruning runs, and cumulative stats (total parts dropped, tokens saved). Call it when the user asks if Jev compaction is enabled, working, or wants pruning stats.',
        args: {},
        execute: async () => statusSnapshot(),
      }),
    },
  };
};

export default FastJevCompactionPlugin;
