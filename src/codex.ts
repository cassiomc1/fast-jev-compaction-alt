import { compact } from './compact.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolCall,
} from './types.js';

/**
 * Structural representation of a Responses/Codex item.
 *
 * The adapter deliberately does not import an OpenAI or Codex SDK. This keeps
 * the core package usable from the Codex CLI, a Responses API client, and
 * tests that only have JSON items available.
 */
export interface CodexItem {
  type: string;
  [key: string]: unknown;
}

export interface CodexAdapterStats {
  itemsDropped: number;
  itemsTruncated: number;
}

const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

function stringField(item: CodexItem, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' ? value : undefined;
}

function roleOf(item: CodexItem): Message['role'] {
  return item.role === 'assistant' ? 'assistant' : 'user';
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable output]';
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { arguments: parsed };
  } catch {
    return { arguments: value };
  }
}

function itemText(item: CodexItem): string {
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string'
        ? record.text
        : typeof record.value === 'string'
          ? record.value
          : '';
    })
    .filter(Boolean)
    .join('\n');
}

function callId(item: CodexItem): string | undefined {
  return stringField(item, 'call_id') ?? stringField(item, 'callId') ?? stringField(item, 'id');
}

function toolName(item: CodexItem): string {
  return stringField(item, 'name') ?? stringField(item, 'tool') ?? 'unknown';
}

function resultText(item: CodexItem): string {
  return stringifyValue(item.output ?? item.result ?? item.error);
}

/** Converts Responses/Codex items into the library's paired transcript shape. */
export function codexToMessages(items: readonly CodexItem[]): Message[] {
  return items.map((item) => {
    const id = callId(item);
    if (CALL_TYPES.has(item.type) && id) {
      const toolUse: Message['toolUses'][number] = {
        tool_use_id: id,
        tool: toolName(item),
        input: parseArguments(item.arguments ?? item.input),
      };
      return { role: 'assistant', text: '', toolUses: [toolUse] };
    }
    if (RESULT_TYPES.has(item.type) && id) {
      const text = resultText(item);
      return {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{
          tool_use_id: id,
          text,
          isError: item.status === 'error' || typeof item.error === 'string',
        }],
      };
    }
    return { role: roleOf(item), text: itemText(item), toolUses: [] };
  });
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
 * Applies decisions to Responses/Codex items. The input is not mutated, so a
 * caller can choose whether to replace its request payload or retain it.
 */
export function applyDecisionsToCodex(
  items: readonly CodexItem[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  statsOut?: CodexAdapterStats,
): CodexItem[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  return items.flatMap((item) => {
    const id = callId(item);
    const action = id ? actions.get(id) : undefined;
    if (action === 'drop_call' && (CALL_TYPES.has(item.type) || RESULT_TYPES.has(item.type))) {
      if (statsOut) statsOut.itemsDropped += 1;
      return [];
    }
    if (action !== 'drop_result' || !RESULT_TYPES.has(item.type)) return [item];

    const text = resultText(item);
    const isError = item.status === 'error' || typeof item.error === 'string';
    const truncated = truncatedResultText(text, isError, headChars);
    if (truncated === text) return [item];
    if (statsOut) statsOut.itemsTruncated += 1;
    const copy: CodexItem = { ...item };
    if ('output' in copy) copy.output = truncated;
    else if ('error' in copy) copy.error = truncated;
    else if ('result' in copy) copy.result = truncated;
    else copy.output = truncated;
    return [copy];
  });
}

/** Convenience function for a complete Codex/Responses compaction round. */
export function compactCodexItems(
  items: readonly CodexItem[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  return compact(codexToMessages(items), asker, options);
}
