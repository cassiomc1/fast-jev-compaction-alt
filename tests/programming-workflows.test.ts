import { describe, expect, it } from 'vitest';

import { compact, reductionRatio } from '../src/compact.js';
import { collectToolCalls, fitState } from '../src/state.js';
import type { JevAsker, Message } from '../src/types.js';

function message(role: Message['role'], text = '', extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  result: string,
  isError = false,
): Message[] {
  return [
    message('assistant', '', {
      toolUses: [{ tool_use_id: id, tool, input, text: result, ...(isError ? { isError: true } : {}) }],
    }),
    message('user', '', {
      toolResults: [{ tool_use_id: id, text: result, ...(isError ? { isError: true } : {}) }],
    }),
  ];
}

function programmingTranscript(): Message[] {
  return [
    message('user', 'Fix the regression. Never edit src/generated. Keep the exact failing assertion.'),
    ...call('read-1', 'Read', { file_path: 'src/service.ts' }, 'export function service() { return 1; }\n'.repeat(80)),
    ...call('grep-1', 'Grep', { pattern: 'TODO', path: 'src' }, 'src/old.ts:1: TODO\nsrc/old.ts:2: TODO'),
    ...call('edit-1', 'Edit', { file_path: 'src/service.ts' }, 'Applied patch successfully.'),
    ...call('test-1', 'Bash', { command: 'npm test' }, 'FAIL tests/service.test.ts\nExpected: 2\nReceived: 1\n', true),
    message('assistant', 'The test still fails in service.ts; I need to inspect the assertion.'),
  ];
}

describe('programming workflows', () => {
  it('preserves constraints and failed test evidence while dropping stale coding history', async () => {
    const messages = programmingTranscript();
    const calls = collectToolCalls(messages, 1);
    expect(calls.map((item) => item.id)).toEqual(['t1', 't2', 't3', 't4']);

    const asker: JevAsker = {
      ask: async (_state, questions) => ({
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => {
            const id = key.split('_')[1];
            const score =
              id === 't1' || id === 't2'
                ? 0.05
                : id === 't3'
                  ? key.startsWith('call_')
                    ? 0.95
                    : 0.05
                  : 0.95;
            return [key, { type: 'noul' as const, noul: score }];
          }),
        ),
      }),
    };

    const result = await compact(messages, asker, {
      preserveRecentMessages: 1,
      truncateHeadChars: 40,
    });
    const output = result.messages;

    expect(output[0]?.text).toBe(messages[0]?.text);
    expect(JSON.stringify(output)).toContain('Expected: 2');
    expect(JSON.stringify(output)).toContain('src/generated');
    expect(result.decisions.map((item) => item.action)).toEqual([
      'drop_call',
      'drop_call',
      'drop_result',
      'keep',
    ]);
    expect(output.flatMap((item) => item.toolResults ?? []).map((item) => item.tool_use_id)).toEqual([
      'edit-1',
      'test-1',
    ]);
    expect(output.flatMap((item) => item.toolUses).map((item) => item.tool_use_id)).toEqual([
      'edit-1',
      'test-1',
    ]);
    expect(reductionRatio(result)).toBeGreaterThan(0.5);
  });

  it('fits a large coding history without sending raw tool output to Jev', async () => {
    const messages: Message[] = [message('user', 'Investigate the flaky integration test.')];
    for (let index = 0; index < 24; index += 1) {
      messages.push(
        ...call(
          `tool-${index}`,
          index % 2 === 0 ? 'Read' : 'Bash',
          { file_path: `src/module-${index}.ts`, command: 'npm test' },
          `raw-output-${index}\n${'detail '.repeat(180)}`,
        ),
      );
    }
    messages.push(message('assistant', 'The flaky test is isolated.'));

    const calls = collectToolCalls(messages, 1);
    const fitted = fitState(messages, calls, {
      goal: 'Fix the flaky integration test without changing generated code.',
      preserveRecentMessages: 1,
      maxStateTokens: 2200,
    });

    expect(fitted.tokens).toBeLessThanOrEqual(2200);
    expect(fitted.stats?.compactedCalls ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(fitted.state)).not.toContain('detail detail detail detail detail detail');
    expect(JSON.stringify(fitted.state)).toContain('t1 Read');
    expect(JSON.stringify(fitted.state)).toContain('1273ch');
    expect(fitted.state.goal).toContain('generated code');
  });

  it('keeps concurrent Jev batches bounded during a large tool history', async () => {
    const messages: Message[] = [message('user', 'Run the checks and diagnose failures.')];
    for (let index = 0; index < 14; index += 1) {
      messages.push(...call(`batch-${index}`, 'Bash', { command: `npm test -- --run ${index}` }, 'PASS\n' + 'ok '.repeat(120)));
    }
    messages.push(message('assistant', 'Summarize the failing checks.'));

    let active = 0;
    let peak = 0;
    const asker: JevAsker = {
      ask: async (_state, questions) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: name.startsWith('result_') ? 0.1 : 0.9 }]),
          ),
        };
      },
    };

    const result = await compact(messages, asker, {
      preserveRecentMessages: 1,
      maxStateTokens: 700,
      maxRequestTokens: 900,
      maxConcurrentRequests: 2,
    });

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.stats.requests).toBeGreaterThan(1);
    expect(result.decisions.filter((item) => item.action === 'drop_result')).toHaveLength(14);
  });
});
