import { DEFAULT_OPTIONS, reductionRatio } from './compact.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  Message,
  ToolCall,
} from './types.js';

/**
 * OpenCode adapter: converts OpenCode `{ info, parts }` messages to the
 * library's `Message` shape and maps Jev decisions back onto OpenCode parts.
 *
 * OpenCode keeps a tool call and its output in a single `tool` part
 * (`state.input` + `state.output`/`state.error`), while the library pairs a
 * `ToolUse` with a `ToolResult` by `tool_use_id`. The adapter synthesises both
 * sides from each completed/errored tool part so `collectToolCalls` sees one
 * candidate per tool part. Pending/running parts have no output yet and are
 * never candidates.
 *
 * The adapter is structural on purpose: it mirrors the SDK's `Message`/`Part`
 * shapes without importing `@opencode-ai/sdk`, so the library stays usable
 * without the OpenCode packages installed.
 */

/** Minimal `info` of an OpenCode message (user or assistant). */
export interface OpenCodeMessageInfo {
  role: 'user' | 'assistant';
}

/** Minimal `state` of an OpenCode `tool` part. */
export interface OpenCodeToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

/** Minimal OpenCode part: only the fields the adapter reads or writes. */
export interface OpenCodePart {
  type: string;
  /** Present on `text` parts. */
  text?: string;
  /** Present on `tool` parts; the library's `tool_use_id` equivalent. */
  callID?: string;
  /** Present on `tool` parts. */
  tool?: string;
  /** Present on `tool` parts. */
  state?: OpenCodeToolState;
  [key: string]: unknown;
}

/** One OpenCode message with its parts, as `session.messages` returns. */
export interface OpenCodeMessageWithParts {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

/** Per-tool bias added to Jev scores before the keep/drop threshold comparison. */
export interface ToolWeightEntry {
  /** Bias added to the keepCall score. Default 0. */
  callBias?: number;
  /** Bias added to the keepResult score. Default 0. */
  resultBias?: number;
}

/**
 * Default weights: shell/bash results are expensive to re-run (test suites,
 * builds), so their result score gets a positive bias. Edit/write calls
 * document the change history and get a call bias.
 */
export const DEFAULT_TOOL_WEIGHTS: Record<string, ToolWeightEntry> = {
  shell:  { callBias: 0, resultBias: 0.15 },
  bash:   { callBias: 0, resultBias: 0.15 },
  edit:   { callBias: 0.1, resultBias: 0 },
  write:  { callBias: 0.1, resultBias: 0 },
};

/** Options accepted by the OpenCode plugin (plugin options object). */
export interface OpenCodePluginOptions extends CompactOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Minimum estimated char reduction required to apply pruning. Default 0. */
  minReductionRatio?: number;
  /** Set to false to disable Jev pruning while keeping the plugin loaded. */
  enabled?: boolean;
  /**
   * Path of a JSONL file receiving one stats-only line per hook invocation
   * (no message content, only counts and decisions). Useful to verify the
   * plugin is pruning in a live session. Also readable from
   * `FAST_JEV_DEBUG_FILE`.
   */
  debugFile?: string;
  /**
   * Per-tool-name bias added to Jev keep scores before the threshold
   * comparison. Tool names are matched case-insensitively. Merges with
   * (and overrides) the built-in defaults for shell/bash/edit/write.
   * Set a tool to `{ callBias: 0, resultBias: 0 }` to neutralise a default.
   */
  toolWeights?: Record<string, ToolWeightEntry>;
}

export interface ResolvedOpenCodeConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  goal?: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  minReductionRatio: number;
  enabled: boolean;
  debugFile?: string;
  /** Merged tool weights (defaults + user overrides), keys lower-cased. */
  toolWeights: Record<string, ToolWeightEntry>;
}

export const OPENCODE_DEFAULTS = {
  ...DEFAULT_OPTIONS,
  model: 'jev-latest',
  minReductionRatio: 0,
  enabled: true,
} as const;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Merges default tool weights with user overrides; all keys are lower-cased. */
function mergeToolWeights(
  defaults: Record<string, ToolWeightEntry>,
  overrides?: Record<string, ToolWeightEntry>,
): Record<string, ToolWeightEntry> {
  const merged: Record<string, ToolWeightEntry> = {};
  for (const [key, value] of Object.entries(defaults)) {
    merged[key.toLowerCase()] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      merged[key.toLowerCase()] = value;
    }
  }
  return merged;
}

/** Returns the bias for a tool name (case-insensitive). */
export function lookupToolWeight(
  weights: Record<string, ToolWeightEntry>,
  toolName: string,
): ToolWeightEntry {
  return weights[toolName.toLowerCase()] ?? { callBias: 0, resultBias: 0 };
}

/**
 * Merges plugin options with environment. `env` defaults to `process.env`
 * when available (Bun/Node) and to `{}` otherwise.
 */
export function resolveOpenCodeConfig(
  options: OpenCodePluginOptions = {},
  env?: Record<string, string | undefined>,
): ResolvedOpenCodeConfig {
  const e: Record<string, string | undefined> =
    env ?? (typeof process !== 'undefined' ? process.env : {});
  const apiKey =
    typeof options.apiKey === 'string' && options.apiKey.length > 0
      ? options.apiKey
      : e['TYPESAFE_API_KEY'];
  const model =
    typeof options.model === 'string' && options.model.length > 0
      ? options.model
      : (e['JEV_MODEL'] ?? OPENCODE_DEFAULTS.model);
  const debugFile =
    typeof options.debugFile === 'string' && options.debugFile.length > 0
      ? options.debugFile
      : e['FAST_JEV_DEBUG_FILE'];
  return {
    apiKey,
    model,
    baseUrl: options.baseUrl,
    goal: options.goal,
    keepThreshold: clamp01(finite(options.keepThreshold, OPENCODE_DEFAULTS.keepThreshold)),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, OPENCODE_DEFAULTS.preserveRecentMessages)),
    ),
    maxStateTokens: Math.max(
      1,
      finite(options.maxStateTokens, OPENCODE_DEFAULTS.maxStateTokens),
    ),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, OPENCODE_DEFAULTS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, OPENCODE_DEFAULTS.truncateHeadChars)),
    ),
    minReductionRatio: clamp01(finite(options.minReductionRatio, OPENCODE_DEFAULTS.minReductionRatio)),
    enabled: options.enabled ?? OPENCODE_DEFAULTS.enabled,
    debugFile,
    toolWeights: mergeToolWeights(DEFAULT_TOOL_WEIGHTS, options.toolWeights),
  };
}

function toolOutput(part: OpenCodePart): { text: string; isError: boolean; hasResult: boolean } {
  const state = part.state;
  if (!state) return { text: '', isError: false, hasResult: false };
  if (state.status === 'completed') {
    return { text: state.output ?? '', isError: false, hasResult: true };
  }
  if (state.status === 'error') {
    return { text: state.error ?? '', isError: true, hasResult: true };
  }
  return { text: '', isError: false, hasResult: false };
}

/**
 * Converts OpenCode messages to library messages. Each entry becomes exactly
 * one library message, so `callIndex`/`resultIndex` of a call refer to the
 * entry holding the tool part.
 */
export function openCodeToMessages(entries: readonly OpenCodeMessageWithParts[]): Message[] {
  return entries.map((entry) => {
    const texts: string[] = [];
    const toolUses: Message['toolUses'] = [];
    const toolResults: NonNullable<Message['toolResults']> = [];
    for (const part of entry.parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        texts.push(part.text);
      } else if (part.type === 'tool' && typeof part.callID === 'string') {
        const input =
          part.state?.input && typeof part.state.input === 'object' ? part.state.input : {};
        const { text, isError, hasResult } = toolOutput(part);
        toolUses.push({
          tool_use_id: part.callID,
          tool: typeof part.tool === 'string' ? part.tool : 'unknown',
          input,
          text,
          isError,
        });
        if (hasResult) {
          toolResults.push({ tool_use_id: part.callID, text, isError });
        }
      }
    }
    const message: Message = {
      role: entry.info.role,
      text: texts.join('\n'),
      toolUses,
    };
    if (toolResults.length > 0) message.toolResults = toolResults;
    return message;
  });
}

function truncatedToolText(text: string, isError: boolean, headChars: number): string {
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  const removed = Math.max(0, text.length - headChars);
  const replacement = `${head}[fast-jev-compaction truncated ${removed} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
  if (headChars === 0) return replacement;
  return replacement.length < text.length ? replacement : text;
}

/** Part types that carry conversation content into the model. */
const CONTENT_PART_TYPES = new Set(['text', 'tool', 'file', 'reasoning', 'agent', 'subtask']);

function entryHasContent(entry: OpenCodeMessageWithParts): boolean {
  const text = entry.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  if (text.trim().length > 0) return true;
  return entry.parts.some((p) => CONTENT_PART_TYPES.has(p.type) && p.type !== 'text');
}

export interface ApplyToOpenCodeStats {
  partsDropped: number;
  partsTruncated: number;
  messagesDropped: number;
}

/**
 * Applies Jev decisions to OpenCode entries, mutating tool parts in place:
 * dropped calls are spliced out of their entry's `parts` array, dropped
 * results keep a bounded head plus the truncation note. Entries left without
 * any content are excluded from the returned array. The caller must splice the
 * returned array back into `output.messages` in place
 * (`messages.splice(0, messages.length, ...next)`); reassigning
 * `output.messages` is a silent no-op in the OpenCode runtime.
 */
export function applyDecisionsToOpenCode(
  entries: readonly OpenCodeMessageWithParts[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  statsOut?: ApplyToOpenCodeStats,
): OpenCodeMessageWithParts[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  if (actions.size === 0) return [...entries];

  const kept: OpenCodeMessageWithParts[] = [];
  for (const entry of entries) {
    const touched = entry.parts.some(
      (part) =>
        part.type === 'tool' && typeof part.callID === 'string' && actions.has(part.callID),
    );
    if (!touched) {
      kept.push(entry);
      continue;
    }
    const remaining: OpenCodePart[] = [];
    for (const part of entry.parts) {
      if (part.type !== 'tool' || typeof part.callID !== 'string') {
        remaining.push(part);
        continue;
      }
      const action = actions.get(part.callID);
      if (action === 'drop_call') {
        if (statsOut) statsOut.partsDropped += 1;
        continue;
      }
      if (action === 'drop_result' && part.state) {
        const { text, isError, hasResult } = toolOutput(part);
        if (hasResult) {
          const truncated = truncatedToolText(text, isError, headChars);
          if (truncated !== text) {
            if (part.state.status === 'completed') part.state.output = truncated;
            else if (part.state.status === 'error') part.state.error = truncated;
            if (statsOut) statsOut.partsTruncated += 1;
          }
        }
      }
      remaining.push(part);
    }
    // Mutate the entry's parts array in place so live references stay valid.
    entry.parts.splice(0, entry.parts.length, ...remaining);
    if (!entryHasContent(entry)) {
      if (statsOut) statsOut.messagesDropped += 1;
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

/** One-line human summary of a compaction result, shared by both hosts. */
export function decisionSummary(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${Math.round(reductionRatio(result) * 100)}% reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

/** Per-call `id:tool:action/call=/result=` diagnostics line. */
export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export const COMPACTION_FALLBACK_GUIDANCE = [
  'fast-jev-compaction: Jev is unavailable for this compaction.',
  'Preserve verbatim: file paths, exact error text, constraints (e.g. never edit generated files),',
  'commands run, and the newest tool outputs. Prefer dropping stale tool outputs over rewording text.',
].join(' ');

/** Short guidance pushed when the session holds no Jev candidates. */
export const COMPACTION_VERBATIM_GUIDANCE = [
  'fast-jev-compaction: preserve verbatim details in the summary — file paths, exact error text,',
  'constraints, commands run, and the newest tool outputs. Prefer dropping stale tool outputs over rewording text.',
].join(' ');

/** Guidance specific to test outputs, injected when test tool calls are detected. */
export const COMPACTION_TEST_GUIDANCE = [
  'When test outputs are present, preserve exact assertion errors, stack traces, and failing test names verbatim.',
  'Passing test lists may be summarised (e.g. "42 tests passed"), but keep every failing test detail intact.',
].join(' ');

/** Patterns that identify a shell/bash command as a test execution. */
export const TEST_COMMAND_PATTERNS = [
  /\bnpm\s+test\b/i,
  /\bnpx\s+(vitest|jest|mocha|ava)\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bpytest\b/i,
  /\bpython\s+-m\s+(pytest|unittest)\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bmake\s+test\b/i,
  /\brspec\b/i,
  /\bbun\s+test\b/i,
  /\bdeno\s+test\b/i,
];

/** Shell-like tool names (lower-cased). */
const SHELL_TOOLS = new Set(['shell', 'bash', 'terminal', 'command']);

/** True when a tool part looks like a test execution. */
export function isTestCommand(part: OpenCodePart): boolean {
  if (part.type !== 'tool' || !part.state?.input) return false;
  const toolLower = (part.tool ?? '').toLowerCase();
  if (!SHELL_TOOLS.has(toolLower)) return false;
  const input = part.state.input;
  const command =
    typeof input['command'] === 'string'
      ? input['command']
      : typeof input['cmd'] === 'string'
        ? input['cmd']
        : '';
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Builds the `context` strings injected into OpenCode's
 * `experimental.session.compacting` hook so the built-in summariser keeps what
 * Jev judged still needed and may drop what Jev let go.
 */
export function compactionContext(result: CompactResult): string[] {
  const kept = result.decisions
    .filter((d) => d.action === 'keep')
    .map((d) => `${d.id} ${d.tool}${d.tool_use_id ? ` [callID: ${d.tool_use_id}]` : ''}`);
  const dropped = result.decisions
    .filter((d) => d.action !== 'keep')
    .map(
      (d) =>
        `${d.id} ${d.tool} (${d.action === 'drop_result' ? 'output stale' : 'call stale'})${
          d.tool_use_id ? ` [callID: ${d.tool_use_id}]` : ''
        }`,
    );
  const context = [
    `fast-jev-compaction scored every tool call for whether it is still needed (${decisionSummary(result)}).`,
  ];
  if (kept.length > 0) {
    context.push(
      `Treat these tool calls and their outputs as still relevant and preserve them in the summary: ${kept.join(', ')}.`,
    );
  }
  if (dropped.length > 0) {
    context.push(
      `These tool calls were judged stale and may be summarised in one line or omitted: ${dropped.join(', ')}.`,
    );
  }
  const log = decisionLog(result);
  if (log) context.push(`Jev scores: ${log}`);
  // Add test-specific guidance when any shell-like tool is in the decisions.
  const hasShellCalls = result.decisions.some((d) => SHELL_TOOLS.has(d.tool.toLowerCase()));
  if (hasShellCalls) context.push(COMPACTION_TEST_GUIDANCE);
  return context;
}

/**
 * Builds system-prompt guidance lines describing what was pruned in the
 * current request so the assistant avoids redundant re-reads.
 */
export function pruningSystemGuidance(
  result: CompactResult,
  stats: ApplyToOpenCodeStats,
  truncateHeadChars: number = 300,
): string[] {
  if (stats.partsDropped === 0 && stats.partsTruncated === 0 && stats.messagesDropped === 0) {
    return [];
  }
  const lines: string[] = [
    '[fast-jev-compaction] Some older tool outputs in this conversation were pruned to save context:',
  ];
  const truncated = result.decisions.filter((d) => d.action === 'drop_result');
  const dropped = result.decisions.filter((d) => d.action === 'drop_call');
  if (truncated.length > 0) {
    const preserved =
      truncateHeadChars === 0
        ? 'result body removed; only a truncation note remains'
        : `only first ~${truncateHeadChars} chars kept`;
    lines.push(
      `- ${truncated.length} tool result(s) truncated (${preserved}): ${truncated.map((d) => `${d.tool}[${d.id}]`).join(', ')}`,
    );
  }
  if (dropped.length > 0) {
    lines.push(
      `- ${dropped.length} tool call(s) fully removed (stale): ${dropped.map((d) => `${d.tool}[${d.id}]`).join(', ')}`,
    );
  }
  lines.push(
    'If a tool result you need was truncated, re-run the tool. Removed calls were judged no longer relevant.',
  );
  return lines;
}
