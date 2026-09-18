import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  maxConcurrentRequests: 3,
  requestTimeoutMs: 15_000,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;
const MIN_QUESTION_BUDGET = 150;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const maxRequestTokens = Math.max(
    1,
    Math.floor(finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens)),
  );
  const minRequiredRequest = REQUEST_OVERHEAD_TOKENS + MIN_QUESTION_BUDGET + 1;
  if (maxRequestTokens < minRequiredRequest) {
    throw new Error(
      `maxRequestTokens must be at least ${minRequiredRequest} to leave room for overhead and question budget`,
    );
  }

  const safeMaxStateTokens = maxRequestTokens - REQUEST_OVERHEAD_TOKENS - MIN_QUESTION_BUDGET;
  const requestedStateTokens = Math.max(
    1,
    Math.floor(finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
  );
  const maxStateTokens = Math.min(requestedStateTokens, safeMaxStateTokens);

  const pinnedToolUseIds = options.pinnedToolUseIds
    ? options.pinnedToolUseIds instanceof Set
      ? options.pinnedToolUseIds
      : new Set(options.pinnedToolUseIds)
    : undefined;

  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: clamp01(finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold)),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens,
    maxRequestTokens,
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    maxConcurrentRequests: Math.max(
      1,
      Math.floor(
        finite(options.maxConcurrentRequests, DEFAULT_OPTIONS.maxConcurrentRequests),
      ),
    ),
    requestTimeoutMs: Math.max(
      1,
      finite(options.requestTimeoutMs, DEFAULT_OPTIONS.requestTimeoutMs),
    ),
    ...(pinnedToolUseIds ? { pinnedToolUseIds } : {}),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'> & { tool_use_id?: string },
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = {
    id: call.id,
    tool: call.tool,
    ...(call.tool_use_id ? { tool_use_id: call.tool_use_id } : {}),
    ...answer,
  };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  const removed = Math.max(0, text.length - headChars);
  const replacement = `${head}[fast-jev-compaction truncated ${removed} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
  if (headChars === 0) return replacement;
  return replacement.length < text.length ? replacement : text;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

export function resultFromDecisions(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  truncateHeadChars: number,
  inherited: Pick<
    CompactResult['stats'],
    'stateTokens' | 'stateStage' | 'requests' | 'ms'
  >,
): CompactResult {
  const charsBefore = messages.reduce(
    (sum, message) => sum + messageChars(message),
    0,
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    truncateHeadChars,
  );

  const originalResults = new Map<string, string>();
  for (const m of messages) {
    for (const r of m.toolResults ?? []) originalResults.set(r.tool_use_id, r.text);
    for (const t of m.toolUses) if (t.text !== undefined) originalResults.set(t.tool_use_id, t.text);
  }
  const keptResults = new Map<string, string>();
  for (const m of kept) {
    for (const r of m.toolResults ?? []) keptResults.set(r.tool_use_id, r.text);
    for (const t of m.toolUses) if (t.text !== undefined) keptResults.set(t.tool_use_id, t.text);
  }
  let resultsTruncated = 0;
  for (const [id, originalText] of originalResults) {
    const keptText = keptResults.get(id);
    if (keptText !== undefined && keptText !== originalText) {
      resultsTruncated++;
    }
  }

  const resultsMarkedStale = count(decisions, 'result_dropped');

  return {
    messages: kept,
    decisions: [...decisions],
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce(
        (sum, message) => sum + messageChars(message),
        0,
      ),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: resultsMarkedStale,
      resultsTruncated,
      resultsMarkedStale,
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      ...inherited,
    },
  };
}

/**
 * Maps items asynchronously with bounded concurrency.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(
    messages,
    resolved.preserveRecentMessages,
    resolved.pinnedToolUseIds,
  );
  const candidates = calls.filter((call) => !call.pinned);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await mapConcurrent(
      batches,
      resolved.maxConcurrentRequests,
      (batch) => askBatch(asker, state.state, batch),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  return resultFromDecisions(
    messages,
    calls,
    decisions,
    resolved.truncateHeadChars,
    {
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  );
}
