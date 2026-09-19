import { describe, expect, it } from 'vitest';

import {
  applyDecisionsToCodex,
  codexToMessages,
  type CodexItem,
} from '../src/codex.js';
import { decideCall } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';

function transcript(output = 'line one\nline two\nline three'): CodexItem[] {
  return [
    { type: 'message', role: 'user', content: 'Fix the failing test.' },
    {
      type: 'function_call',
      call_id: 'call-read',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/a.ts' }),
    },
    { type: 'function_call_output', call_id: 'call-read', output },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I found it.' }] },
  ];
}

describe('Codex/Responses adapter', () => {
  it('pairs function calls and outputs without depending on a host SDK', () => {
    const messages = codexToMessages(transcript());
    expect(messages).toHaveLength(4);
    expect(messages[1]?.toolUses[0]).toMatchObject({
      tool_use_id: 'call-read',
      tool: 'read_file',
      input: { path: 'src/a.ts' },
    });
    expect(messages[2]?.toolResults?.[0]).toMatchObject({
      tool_use_id: 'call-read',
      text: 'line one\nline two\nline three',
    });
    expect(messages[3]?.text).toBe('I found it.');
  });

  it('keeps malformed JSON arguments as inspectable input', () => {
    const [message] = codexToMessages([
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{not-json' },
    ]);
    expect(message?.toolUses[0]?.input).toEqual({ arguments: '{not-json' });
  });

  it('truncates only the output item and does not mutate the request payload', () => {
    const output = '0123456789' + 'abcdefghij'.repeat(20);
    const items = transcript(output);
    const messages = codexToMessages(items);
    const calls = collectToolCalls(messages, 0);
    const decision = decideCall(
      calls[0]!,
      { keepCall: 0.9, keepResult: 0.1 },
      { keepThreshold: 0.5 },
    );
    const stats = { itemsDropped: 0, itemsTruncated: 0 };
    const next = applyDecisionsToCodex(items, [decision], calls, 10, stats);

    expect(next).not.toBe(items);
    expect(items[2]).toEqual({ type: 'function_call_output', call_id: 'call-read', output });
    expect(next[2]).toMatchObject({
      type: 'function_call_output',
      output: '0123456789\n[fast-jev-compaction truncated 200 chars of this tool result; re-run the tool if needed]',
    });
    expect(stats).toEqual({ itemsDropped: 0, itemsTruncated: 1 });
  });

  it('removes a stale call together with its output while preserving other items', () => {
    const items = transcript();
    const calls = collectToolCalls(codexToMessages(items), 0);
    const decision = decideCall(
      calls[0]!,
      { keepCall: 0.1, keepResult: 0.1 },
      { keepThreshold: 0.5 },
    );
    const stats = { itemsDropped: 0, itemsTruncated: 0 };
    const next = applyDecisionsToCodex(items, [decision], calls, 10, stats);

    expect(next.map((item) => item.type)).toEqual(['message', 'message']);
    expect(stats.itemsDropped).toBe(2);
  });
});
