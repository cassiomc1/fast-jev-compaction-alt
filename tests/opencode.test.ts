import { describe, expect, it, vi, afterEach } from 'vitest';
import { collectToolCalls, compact, decideCall } from '../src/index.js';
import { compactSession, resolveHookConfig } from '../hooks/fast-jev.js';
import {
  applyDecisionsToOpenCode,
  COMPACTION_FALLBACK_GUIDANCE,
  COMPACTION_TEST_GUIDANCE,
  COMPACTION_VERBATIM_GUIDANCE,
  compactionContext,
  decisionSummary,
  DEFAULT_TOOL_WEIGHTS,
  isTestCommand,
  lookupToolWeight,
  openCodeToMessages,
  pruningSystemGuidance,
  resolveOpenCodeConfig,
  type OpenCodeMessageWithParts,
  type OpenCodePart,
} from '../src/opencode.js';
import { FastJevCompactionPlugin } from '../src/plugin.js';
import type { CompactResult } from '../src/types.js';

function textEntry(role: 'user' | 'assistant', text: string): OpenCodeMessageWithParts {
  return { info: { role }, parts: [{ type: 'text', text }] };
}

function toolEntry(
  callID: string,
  tool: string,
  input: Record<string, unknown>,
  output: string,
  status: 'completed' | 'error' | 'pending' = 'completed',
): OpenCodeMessageWithParts {
  return {
    info: { role: 'assistant' },
    parts: [
      {
        type: 'tool',
        id: `part-${callID}`,
        callID,
        tool,
        state:
          status === 'completed'
            ? { status, input, output }
            : status === 'error'
              ? { status, input, error: output }
              : { status, input },
      },
    ],
  };
}

const fileA = 'export const a = 1;\n'.repeat(100); // 1900 chars
const fileB = 'export const b = 2;\n'.repeat(100);

function transcript(): OpenCodeMessageWithParts[] {
  return [
    textEntry('user', 'Never edit src/generated. Fix the failing test.'),
    toolEntry('c1', 'Read', { file_path: 'src/a.ts' }, fileA),
    {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'a looks fine' }, toolEntry('c2', 'Bash', { command: 'npm test' }, `PASS\n${'✓ ok\n'.repeat(400)}`).parts[0]!],
    },
    toolEntry('c3', 'Read', { file_path: 'src/b.ts' }, fileB),
    textEntry('user', 'go ahead'),
  ];
}

function fakeFetch(answer: (name: string) => number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: async () => JSON.stringify({ answers }) } as unknown as Response;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveOpenCodeConfig', () => {
  it('fills defaults and prefers options over env', () => {
    expect(resolveOpenCodeConfig({}, {})).toMatchObject({
      model: 'jev-latest',
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      minReductionRatio: 0,
      enabled: true,
      apiKey: undefined,
    });
    expect(
      resolveOpenCodeConfig({ apiKey: 'k', model: 'jev-x', enabled: false }, { TYPESAFE_API_KEY: 'env' }),
    ).toMatchObject({ apiKey: 'k', model: 'jev-x', enabled: false });
    expect(resolveOpenCodeConfig({}, { TYPESAFE_API_KEY: 'env' }).apiKey).toBe('env');
  });
});

describe('openCodeToMessages', () => {
  it('joins text parts and synthesises tool uses with results', () => {
    const messages = openCodeToMessages(transcript());
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({ role: 'user', text: expect.stringContaining('Never edit') });
    expect(messages[2]?.text).toBe('a looks fine');
    expect(messages[1]?.toolUses[0]).toMatchObject({ tool_use_id: 'c1', tool: 'Read' });
    expect(messages[1]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'c1', text: fileA });
  });

  it('leaves pending calls without a result so they are never candidates', () => {
    const messages = openCodeToMessages([toolEntry('c9', 'Bash', { command: 'sleep 1' }, '', 'pending')]);
    expect(messages[0]?.toolUses).toHaveLength(1);
    expect(messages[0]?.toolResults ?? []).toHaveLength(0);
    expect(collectToolCalls(messages, 0)).toHaveLength(0);
  });

  it('marks error outputs as errors', () => {
    const messages = openCodeToMessages([toolEntry('c9', 'Bash', {}, 'boom', 'error')]);
    expect(messages[0]?.toolResults?.[0]).toMatchObject({ text: 'boom', isError: true });
  });
});

describe('applyDecisionsToOpenCode', () => {
  it('truncates stale results, removes stale calls and emptied messages in place', () => {
    const entries = transcript();
    const entryPartsBefore = entries.map((e) => e.parts);
    const libMessages = openCodeToMessages(entries);
    const calls = collectToolCalls(libMessages, 1);
    expect(calls.map((c) => [c.id, c.tool_use_id, c.pinned])).toEqual([
      ['t1', 'c1', false],
      ['t2', 'c2', false],
      ['t3', 'c3', false],
    ]);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[2]!, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5 }),
    ];
    const stats = { partsDropped: 0, partsTruncated: 0, messagesDropped: 0 };
    const next = applyDecisionsToOpenCode(entries, decisions, calls, 300, stats);

    // c1 kept verbatim.
    expect(entries[1]?.parts[0]).toBe(entryPartsBefore[1]?.[0]);
    // c2 result truncated with the library's note.
    const c2 = entries[2]?.parts.find((p) => p.callID === 'c2');
    expect(c2?.state?.output).toMatch(/^\S[\s\S]*\[fast-jev-compaction truncated \d+ chars/);
    // c3 call dropped; its entry had no other content, so it is gone.
    expect(next).toHaveLength(4);
    expect(next.some((e) => e.parts.some((p) => p.callID === 'c3'))).toBe(false);
    // Touched entries keep their parts array identity (in-place splice).
    expect(entries[2]?.parts).toBe(entryPartsBefore[2]);
    expect(stats).toMatchObject({ partsDropped: 1, partsTruncated: 1, messagesDropped: 1 });
  });
});

describe('compaction context', () => {
  it('lists kept and stale calls for the summary prompt', () => {
    const libMessages = openCodeToMessages(transcript());
    const calls = collectToolCalls(libMessages, 1);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[2]!, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5 }),
    ];
    const result = {
      decisions,
      stats: {
        kept: 1,
        resultsDropped: 1,
        callsDropped: 1,
        pinned: 0,
        stateTokens: 100,
        stateStage: 'full',
        requests: 1,
      },
    } as CompactResult;
    const context = compactionContext(result);
    expect(context.join('\n')).toContain('t1 Read');
    expect(context.join('\n')).toContain('t2 Bash (output stale)');
    expect(context.join('\n')).toContain('t3 Read (call stale)');
    expect(decisionSummary(result)).toContain('reduction');
    expect(COMPACTION_FALLBACK_GUIDANCE).toContain('verbatim');
  });
});

function fakeClient(logged: unknown[], sessionEntries?: OpenCodeMessageWithParts[]) {
  return {
    app: {
      log: async (input: unknown) => {
        logged.push(input);
        return true;
      },
    },
    session: {
      messages: async () => ({ data: sessionEntries ?? [] }),
    },
  };
}

describe('opencode plugin', () => {
  it('prunes the transform payload in place and never reassigns output.messages', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch((name) => {
        if (name === 'call_t1' || name === 'result_t1') return 0.9;
        if (name === 'call_t2') return 0.9;
        return 0.1;
      }),
    );
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    const transform = hooks['experimental.chat.messages.transform'];
    expect(transform).toBeDefined();
    const entries = transcript();
    const output = { messages: entries as unknown[] };
    await transform!({} as never, output as never);
    // Same array reference: the runtime only honours in-place mutation.
    expect(output.messages as unknown[]).toBe(entries as unknown[]);
    expect(entries).toHaveLength(4);
    expect(entries.some((e) => e.parts.some((p) => p.callID === 'c3'))).toBe(false);
    const c2 = entries.flatMap((e) => e.parts).find((p) => p.callID === 'c2');
    expect(c2?.state?.output ?? c2?.state?.error ?? '').toContain('fast-jev-compaction truncated');
    expect(JSON.stringify(logged)).toContain('fast-jev-compaction');
  });

  it('leaves messages untouched when Jev fails', async () => {
    vi.stubGlobal('fetch', async () => {
      return { status: 500, ok: false, text: async () => 'boom' } as unknown as Response;
    });
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    const entries = transcript();
    const before = JSON.stringify(entries);
    const output = { messages: entries as unknown[] };
    await hooks['experimental.chat.messages.transform']!({} as never, output as never);
    expect(JSON.stringify(entries)).toBe(before);
    expect(JSON.stringify(logged)).toContain('skipped');
  });

  it('short-circuits after a 401 instead of retrying every request', async () => {
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return { status: 401, ok: false, text: async () => 'unauthorized' } as unknown as Response;
    });
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'bad-key', preserveRecentMessages: 1 } as never,
    );
    const transform = hooks['experimental.chat.messages.transform']!;
    for (let i = 0; i < 2; i++) {
      const entries = transcript();
      const before = JSON.stringify(entries);
      await transform({} as never, { messages: entries as unknown[] } as never);
      expect(JSON.stringify(entries)).toBe(before);
    }
    expect(fetchCalls).toBe(1);
    expect(JSON.stringify(logged)).toContain('disabled until OpenCode reloads');
  });

  it('pushes verbatim guidance when the session holds no candidates', async () => {
    const logged: unknown[] = [];
    const session = [textEntry('user', 'hello'), textEntry('assistant', 'hi there')];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged, session) } as never,
      { apiKey: 'k' } as never,
    );
    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await hooks['experimental.session.compacting']!({ sessionID: 's1' } as never, output as never);
    expect(output.context).toEqual([COMPACTION_VERBATIM_GUIDANCE]);
  });

  it('writes stats-only debug lines when debugFile is configured', async () => {    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'jev-debug-'));
    try {
      const debugFile = join(dir, 'hooks.jsonl');
      vi.stubGlobal(
        'fetch',
        fakeFetch((name) => {
          if (name === 'call_t1' || name === 'result_t1') return 0.9;
          if (name === 'call_t2') return 0.9;
          return 0.1;
        }),
      );
      const logged: unknown[] = [];
      const hooks = await FastJevCompactionPlugin(
        { client: fakeClient(logged) } as never,
        { apiKey: 'k', preserveRecentMessages: 1, debugFile } as never,
      );
      const entries = transcript();
      await hooks['experimental.chat.messages.transform']!(
        {} as never,
        { messages: entries as unknown[] } as never,
      );
      const lines = readFileSync(debugFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ hook: 'transform', outcome: 'pruned' });
      expect(lines[0].messagesAfter).toBeLessThan(lines[0].messagesBefore);
      expect(lines[0].partsDropped).toBeGreaterThan(0);
      expect(JSON.stringify(lines[0])).not.toContain('export const a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects Jev guidance into the compacting prompt, with fallback without a key', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => 0.1));
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged, transcript()) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await hooks['experimental.session.compacting']!({ sessionID: 's1' } as never, output as never);
    expect(output.context.join('\n')).toContain('fast-jev-compaction');

    const savedKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const logged2: unknown[] = [];
      const hooks2 = await FastJevCompactionPlugin(
        { client: fakeClient(logged2, transcript()) } as never,
        {} as never,
      );
      const output2 = { context: [] as string[], prompt: undefined as string | undefined };
      await hooks2['experimental.session.compacting']!({ sessionID: 's1' } as never, output2 as never);
      expect(output2.context.join('\n')).toContain('unavailable');
    } finally {
      if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
    }
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzEntries(seed: number): OpenCodeMessageWithParts[] {
  const r = mulberry32(seed);
  const alpha = 'abcdefáéç \n\t[]{}"';
  const str = (max: number): string => {
    let s = '';
    const n = Math.floor(r() * (max + 1));
    for (let i = 0; i < n; i++) s += alpha[Math.floor(r() * alpha.length)];
    return s;
  };
  const tools = ['Read', 'Bash', 'Edit'];
  // Unique ids: real OpenCode callIDs are unique per tool part. Duplicate ids
  // collapse to one action per id (last decision wins, as in the Claude path),
  // which per-decision invariants cannot cover; duplicates get their own test.
  let seq = 0;
  const entries: OpenCodeMessageWithParts[] = [];
  const n = Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const parts: OpenCodeMessageWithParts['parts'] = [];
    const nparts = Math.floor(r() * 4);
    for (let j = 0; j < nparts; j++) {
      const k = r();
      if (k < 0.4) parts.push({ type: 'text', text: str(200) });
      else if (k < 0.75) {
        const part: OpenCodeMessageWithParts['parts'][number] = {
          type: 'tool',
          callID: `c${seed}-${seq++}`,
          tool: tools[Math.floor(r() * tools.length)],
        };
        const st = r();
        if (st < 0.6) part.state = { status: 'completed', input: { q: str(80) }, output: str(3000) };
        else if (st < 0.8) part.state = { status: 'error', input: {}, error: str(1500) };
        else part.state = { status: 'pending', input: {} };
        parts.push(part);
      } else if (k < 0.85) parts.push({ type: 'reasoning', text: str(100) });
      else if (k < 0.9) parts.push({ type: 'step-start' });
      else if (k < 0.95) parts.push({ type: 'step-finish', reason: 'stop' });
      else parts.push({ type: 'file', mime: 'text/plain', url: 'file:///x' });
    }
    entries.push({ info: { role: r() < 0.5 ? 'user' : 'assistant' }, parts });
  }
  return entries;
}

describe('opencode adapter fuzz', () => {
  it('holds invariants over seeded transcripts (offline, fake Jev)', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const entries = fuzzEntries(seed);
      const beforeNonTool = entries
        .flatMap((e) => e.parts)
        .filter((p) => p.type !== 'tool');
      const beforeOut = entries
        .flatMap((e) => e.parts)
        .filter((p) => p.type === 'tool' && p.state && (p.state.status === 'completed' || p.state.status === 'error'))
        .reduce((sum, p) => sum + ((p.state!.output ?? p.state!.error ?? '').length), 0);
      const preserve = seed % 5;
      const jr = mulberry32(seed * 31 + 7);
      const asker = {
        ask: async (_state: unknown, questions: Record<string, unknown>) => ({
          answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: jr() }])),
        }),
      };
      const msgs = openCodeToMessages(entries);
      const calls = collectToolCalls(msgs, preserve);
      const result = await compact(msgs, asker, { preserveRecentMessages: preserve, truncateHeadChars: 100 });
      const stats = { partsDropped: 0, partsTruncated: 0, messagesDropped: 0 };
      const next = applyDecisionsToOpenCode(entries, result.decisions, calls, 100, stats);
      expect(next.length).toBeLessThanOrEqual(entries.length);
      expect(
        entries.flatMap((e) => e.parts).filter((p) => p.type !== 'tool'),
      ).toEqual(beforeNonTool);
      for (const d of result.decisions) {
        if (d.reason === 'pinned') expect(d.action).toBe('keep');
      }
      const droppedIds = new Set(
        result.decisions
          .filter((d) => d.action === 'drop_call')
          .map((d) => calls.find((c) => c.id === d.id)?.tool_use_id),
      );
      for (const p of entries.flatMap((e) => e.parts)) {
        if (p.type === 'tool' && p.callID && droppedIds.has(p.callID)) {
          throw new Error(`seed ${seed}: dropped call ${p.callID} still present`);
        }
      }
      const afterOut = entries
        .flatMap((e) => e.parts)
        .filter((p) => p.type === 'tool' && p.state && (p.state.status === 'completed' || p.state.status === 'error'))
        .reduce((sum, p) => sum + ((p.state!.output ?? p.state!.error ?? '').length), 0);
      expect(afterOut).toBeLessThanOrEqual(beforeOut);
    }
  });
});

describe('duplicate callIDs', () => {
  it('collapses to one action per id without crashing (last decision wins)', async () => {
    const entries: OpenCodeMessageWithParts[] = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'tool', callID: 'dup', tool: 'Read', state: { status: 'completed', input: {}, output: 'x'.repeat(2000) } }],
      },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'tool', callID: 'dup', tool: 'Read', state: { status: 'completed', input: {}, output: 'y'.repeat(2000) } }],
      },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
    ];
    const msgs = openCodeToMessages(entries);
    const calls = collectToolCalls(msgs, 0);
    expect(calls).toHaveLength(2);
    const asker = {
      ask: async (_state: unknown, questions: Record<string, unknown>) => ({
        answers: Object.fromEntries(
          Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: k === 'call_t1' ? 0.01 : 0.9 }]),
        ),
      }),
    };
    const result = await compact(msgs, asker, { preserveRecentMessages: 0 });
    const next = applyDecisionsToOpenCode(entries, result.decisions, calls, 100);
    // t1 (drop_call) then t2 (keep): keep never overwrites, so both parts go.
    // Either way the outcome is consistent: both parts share one fate.
    const remaining = next.flatMap((e) => e.parts).filter((p) => p.callID === 'dup');
    expect([0, 2]).toContain(remaining.length);
    expect(next.length).toBeLessThanOrEqual(entries.length);
  });
});

describe('claude/opencode parity', () => {
  it('reaches identical decisions on both hosts for the same answers', async () => {
    const big1 = 'A'.repeat(3000);
    const big2 = 'B'.repeat(3000);
    const claudeMsgs = [
      { role: 'user', text: 'Fix it. Never touch gen.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { f: 'a' }, text: big1 }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: big1 }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u2', tool: 'Bash', input: { c: 't' }, text: big2 }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u2', text: big2 }] },
      { role: 'assistant', text: 'done', toolUses: [] },
      { role: 'user', text: 'thanks', toolUses: [] },
    ];
    const ocEntries: OpenCodeMessageWithParts[] = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'Fix it. Never touch gen.' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'tool', callID: 'u1', tool: 'Read', state: { status: 'completed', input: { f: 'a' }, output: big1 } }] },
      { info: { role: 'assistant' }, parts: [{ type: 'tool', callID: 'u2', tool: 'Bash', state: { status: 'completed', input: { c: 't' }, output: big2 } }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'thanks' }] },
    ];
    const ansFor = (name: string): number =>
      name.includes('t1') ? 0.95 : name.startsWith('call_') ? 0.9 : 0.1;
    const asker = {
      ask: async (_state: unknown, questions: Record<string, unknown>) => ({
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: ansFor(k) }])),
      }),
    };
    const fetchFn = async (_url: string, init?: { body?: string }) => {
      const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
      return {
        status: 200,
        ok: true,
        text: JSON.stringify({
          answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: ansFor(k) }])),
        }),
      };
    };
    const claudeOut = await compactSession(
      claudeMsgs as never,
      { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'm' },
      fetchFn,
    );
    const ocMsgs = openCodeToMessages(ocEntries);
    const ocCalls = collectToolCalls(ocMsgs, 1);
    const ocRes = await compact(ocMsgs, asker, { preserveRecentMessages: 1 });
    const norm = (ds: { reason: string; tool: string; action: string }[]) =>
      ds.filter((d) => d.reason !== 'pinned').map((d) => [d.tool, d.action]);
    expect(norm(ocRes.decisions)).toEqual(norm(claudeOut.result.decisions));
    const ocNext = applyDecisionsToOpenCode(ocEntries, ocRes.decisions, ocCalls, 300);
    expect(
      ocNext.flatMap((e) => e.parts).filter((p) => p.type === 'text').map((p) => p.text),
    ).toEqual(['Fix it. Never touch gen.', 'done', 'thanks']);
  });
});

describe('jev_compaction_status tool', () => {
  it('reports config and the latest run as JSON', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch((name) => {
        if (name === 'call_t1' || name === 'result_t1') return 0.9;
        if (name === 'call_t2') return 0.9;
        return 0.1;
      }),
    );
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    const statusTool = hooks.tool?.jev_compaction_status;
    expect(statusTool?.description).toContain('fast-jev-compaction');
    const before = JSON.parse(await statusTool!.execute({}, {} as never)) as Record<string, unknown>;
    expect(before).toMatchObject({ plugin: 'fast-jev-compaction', enabled: true, model: 'jev-latest', key: 'configured', lastRun: null });
    expect(JSON.stringify(before)).not.toContain('216194089');
    const entries = transcript();
    await hooks['experimental.chat.messages.transform']!(
      {} as never,
      { messages: entries as unknown[] } as never,
    );
    const after = JSON.parse(await statusTool!.execute({}, {} as never)) as Record<string, unknown>;
    expect(after.lastRun).toMatchObject({ hook: 'transform', outcome: 'pruned' });
  });

  it('includes run history and cumulative stats after multiple runs', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch((name) => {
        if (name === 'call_t1' || name === 'result_t1') return 0.9;
        if (name === 'call_t2') return 0.9;
        return 0.1;
      }),
    );
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    const statusTool = hooks.tool?.jev_compaction_status;
    // Run transform twice.
    for (let i = 0; i < 2; i++) {
      const entries = transcript();
      await hooks['experimental.chat.messages.transform']!(
        {} as never,
        { messages: entries as unknown[] } as never,
      );
    }
    const status = JSON.parse(await statusTool!.execute({}, {} as never)) as Record<string, unknown>;
    const history = status.runHistory as unknown[];
    expect(history.length).toBe(2);
    const cum = status.cumulativeStats as Record<string, number>;
    expect(cum.runs).toBe(2);
    expect(cum.partsDropped).toBeGreaterThan(0);
  });
});

describe('resolveOpenCodeConfig with toolWeights', () => {
  it('merges defaults with user overrides (case-insensitive)', () => {
    const config = resolveOpenCodeConfig(
      { toolWeights: { Shell: { callBias: 0.3, resultBias: 0 } } },
      {},
    );
    // User override for 'Shell' should win over default for 'shell'.
    expect(config.toolWeights['shell']).toEqual({ callBias: 0.3, resultBias: 0 });
    // Other defaults still present.
    expect(config.toolWeights['bash']).toEqual({ callBias: 0, resultBias: 0.15 });
    expect(config.toolWeights['edit']).toEqual({ callBias: 0.1, resultBias: 0 });
  });

  it('includes toolWeights even when no overrides are given', () => {
    const config = resolveOpenCodeConfig({}, {});
    expect(config.toolWeights).toEqual(DEFAULT_TOOL_WEIGHTS);
  });
});

describe('isTestCommand', () => {
  const makeToolPart = (
    tool: string,
    command: string,
    status: 'completed' | 'error' = 'completed',
  ): OpenCodePart => ({
    type: 'tool',
    callID: 'x',
    tool,
    state: status === 'completed'
      ? { status, input: { command }, output: 'done' }
      : { status, input: { command }, error: 'fail' },
  });

  it('detects common test commands', () => {
    expect(isTestCommand(makeToolPart('Bash', 'npm test'))).toBe(true);
    expect(isTestCommand(makeToolPart('Shell', 'npx vitest run'))).toBe(true);
    expect(isTestCommand(makeToolPart('bash', 'pytest -x'))).toBe(true);
    expect(isTestCommand(makeToolPart('shell', 'cargo test --release'))).toBe(true);
    expect(isTestCommand(makeToolPart('bash', 'go test ./...'))).toBe(true);
    expect(isTestCommand(makeToolPart('bash', 'bun test'))).toBe(true);
    expect(isTestCommand(makeToolPart('bash', 'deno test'))).toBe(true);
    expect(isTestCommand(makeToolPart('bash', 'npx jest'))).toBe(true);
    expect(isTestCommand(makeToolPart('bash', 'rspec spec/'))).toBe(true);
  });

  it('rejects non-test commands', () => {
    expect(isTestCommand(makeToolPart('Bash', 'npm install'))).toBe(false);
    expect(isTestCommand(makeToolPart('Bash', 'cat file.ts'))).toBe(false);
    expect(isTestCommand(makeToolPart('Read', 'npm test'))).toBe(false); // not a shell tool
  });

  it('rejects non-tool parts', () => {
    expect(isTestCommand({ type: 'text', text: 'npm test' })).toBe(false);
  });
});

describe('lookupToolWeight', () => {
  it('returns matching weight case-insensitively', () => {
    const weights = { bash: { callBias: 0, resultBias: 0.15 } };
    expect(lookupToolWeight(weights, 'Bash')).toEqual({ callBias: 0, resultBias: 0.15 });
    expect(lookupToolWeight(weights, 'BASH')).toEqual({ callBias: 0, resultBias: 0.15 });
  });

  it('returns zero bias for unknown tools', () => {
    expect(lookupToolWeight({}, 'Unknown')).toEqual({ callBias: 0, resultBias: 0 });
  });
});

describe('compactionContext test guidance', () => {
  it('includes test guidance when shell-like tools are in decisions', () => {
    const result = {
      decisions: [
        { id: 't1', tool: 'Bash', action: 'keep' as const, reason: 'kept' as const, keepCall: 0.9, keepResult: 0.9 },
        { id: 't2', tool: 'Read', action: 'drop_call' as const, reason: 'call_dropped' as const, keepCall: 0.1, keepResult: 0.1 },
      ],
      stats: { kept: 1, resultsDropped: 0, callsDropped: 1, pinned: 0, stateTokens: 100, stateStage: 'full', requests: 1, messagesBefore: 5, messagesAfter: 4, charsBefore: 5000, charsAfter: 3000, calls: 2, ms: 10 },
    } as CompactResult;
    const ctx = compactionContext(result);
    expect(ctx.join('\n')).toContain(COMPACTION_TEST_GUIDANCE);
  });

  it('omits test guidance when no shell tools are present', () => {
    const result = {
      decisions: [
        { id: 't1', tool: 'Read', action: 'keep' as const, reason: 'kept' as const, keepCall: 0.9, keepResult: 0.9 },
      ],
      stats: { kept: 1, resultsDropped: 0, callsDropped: 0, pinned: 0, stateTokens: 100, stateStage: 'full', requests: 1, messagesBefore: 3, messagesAfter: 3, charsBefore: 2000, charsAfter: 2000, calls: 1, ms: 5 },
    } as CompactResult;
    const ctx = compactionContext(result);
    expect(ctx.join('\n')).not.toContain(COMPACTION_TEST_GUIDANCE);
  });
});

describe('pruningSystemGuidance', () => {
  it('returns guidance lines when something was pruned', () => {
    const result = {
      decisions: [
        { id: 't1', tool: 'Read', action: 'drop_result' as const, reason: 'result_dropped' as const, keepCall: 0.9, keepResult: 0.1 },
        { id: 't2', tool: 'Bash', action: 'drop_call' as const, reason: 'call_dropped' as const, keepCall: 0.1, keepResult: 0.1 },
      ],
      stats: { kept: 0, resultsDropped: 1, callsDropped: 1, pinned: 0, stateTokens: 100, stateStage: 'full', requests: 1, messagesBefore: 5, messagesAfter: 3, charsBefore: 5000, charsAfter: 2000, calls: 2, ms: 10 },
    } as CompactResult;
    const stats = { partsDropped: 1, partsTruncated: 1, messagesDropped: 1 };
    const lines = pruningSystemGuidance(result, stats);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('[fast-jev-compaction]');
    expect(lines.join('\n')).toContain('Read[t1]');
    expect(lines.join('\n')).toContain('Bash[t2]');
    expect(lines.join('\n')).toContain('re-run the tool');
  });

  it('returns empty when nothing was pruned', () => {
    const result = {
      decisions: [{ id: 't1', tool: 'Read', action: 'keep' as const, reason: 'kept' as const, keepCall: 0.9, keepResult: 0.9 }],
      stats: { kept: 1, resultsDropped: 0, callsDropped: 0, pinned: 0, stateTokens: 100, stateStage: 'full', requests: 1, messagesBefore: 3, messagesAfter: 3, charsBefore: 2000, charsAfter: 2000, calls: 1, ms: 5 },
    } as CompactResult;
    expect(pruningSystemGuidance(result, { partsDropped: 0, partsTruncated: 0, messagesDropped: 0 })).toEqual([]);
  });
});

describe('test failure pinning in plugin', () => {
  it('pins test error commands and never prunes them', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(() => 0.1), // Jev wants to drop everything
    );
    const logged: unknown[] = [];
    // Transcript with a test failure (Bash running npm test, status error).
    const entries: OpenCodeMessageWithParts[] = [
      textEntry('user', 'Fix the failing test.'),
      toolEntry('c1', 'Read', { file_path: 'src/a.ts' }, fileA),
      toolEntry('c2', 'Bash', { command: 'npm test' }, 'FAIL: expected 1 to equal 2', 'error'),
      textEntry('user', 'go ahead'),
    ];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    const output = { messages: entries as unknown[] };
    await hooks['experimental.chat.messages.transform']!({} as never, output as never);
    // c2 (the test failure) should still be present even though Jev scored 0.1.
    const remaining = (output.messages as OpenCodeMessageWithParts[]).flatMap((e) => e.parts);
    const c2 = remaining.find((p) => p.callID === 'c2');
    expect(c2).toBeDefined();
    expect(c2?.state?.error).toContain('expected 1 to equal 2');
  });
});

describe('system prompt hook', () => {
  it('injects guidance into system prompt after pruning', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch((name) => {
        if (name === 'call_t1' || name === 'result_t1') return 0.9;
        if (name === 'call_t2') return 0.9;
        return 0.1;
      }),
    );
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    // First, run the transform hook to generate pruning guidance.
    const entries = transcript();
    await hooks['experimental.chat.messages.transform']!(
      {} as never,
      { messages: entries as unknown[] } as never,
    );
    // Now run the system prompt hook.
    const systemOutput = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']!(
      {} as never,
      systemOutput as never,
    );
    expect(systemOutput.system.length).toBeGreaterThan(0);
    expect(systemOutput.system.join('\n')).toContain('[fast-jev-compaction]');
    expect(systemOutput.system.join('\n')).toContain('pruned');
  });

  it('injects nothing when there was no pruning', async () => {
    const logged: unknown[] = [];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k' } as never,
    );
    // Don't run transform — system hook should have nothing to inject.
    const systemOutput = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']!(
      {} as never,
      systemOutput as never,
    );
    expect(systemOutput.system).toEqual([]);
  });
});

describe('tool weight bias in plugin', () => {
  it('bash result bias keeps a shell result that Jev would have dropped', async () => {
    // Jev scores the Bash result at 0.4 — below the 0.5 threshold. But the
    // default resultBias of 0.15 pushes it to 0.55, keeping the result.
    vi.stubGlobal(
      'fetch',
      fakeFetch((name) => {
        // Read: both low → drop_call.
        if (name.includes('t1')) return 0.1;
        // Bash call: high, result: just below threshold.
        if (name === 'call_t2') return 0.9;
        if (name === 'result_t2') return 0.4;
        return 0.1;
      }),
    );
    const logged: unknown[] = [];
    const entries: OpenCodeMessageWithParts[] = [
      textEntry('user', 'run the tests'),
      toolEntry('c1', 'Read', { file_path: 'src/a.ts' }, fileA),
      toolEntry('c2', 'Bash', { command: 'npm test' }, `PASS\n${'✓ ok\n'.repeat(200)}`),
      textEntry('user', 'ok'),
    ];
    const hooks = await FastJevCompactionPlugin(
      { client: fakeClient(logged) } as never,
      { apiKey: 'k', preserveRecentMessages: 1 } as never,
    );
    const output = { messages: entries as unknown[] };
    await hooks['experimental.chat.messages.transform']!({} as never, output as never);
    // The Bash result should be kept (bias pushed it over threshold).
    const c2 = (output.messages as OpenCodeMessageWithParts[])
      .flatMap((e) => e.parts)
      .find((p) => p.callID === 'c2');
    expect(c2).toBeDefined();
    // The result should NOT be truncated (it was "kept" not "drop_result").
    expect(c2?.state?.output).not.toContain('fast-jev-compaction truncated');
  });
});
