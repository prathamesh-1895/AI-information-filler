import { createPolicy, type FieldDescriptor } from '@filler/core';
import { describe, expect, it } from 'vitest';
import { AI_ENDPOINTS, AiClient } from './client';
import { createAiSeam } from './seam';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fake(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return handler(url, init);
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (f: ReturnType<typeof fake>, token: string | null = 'jwt-1', timeoutMs?: number) =>
  new AiClient({
    functionsUrl: 'https://p.supabase.co/functions/v1/',
    anonKey: 'anon-1',
    getAccessToken: async () => token,
    fetch: f.fetch,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

const field = (over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: '0:f1',
  frameId: 0,
  selector: '#a',
  tag: 'input',
  inputType: 'text',
  label: 'Favourite tools',
  labelSource: 'label-for',
  required: false,
  isVisible: true,
  isDisabled: false,
  signature: 'a'.repeat(64),
  ...over,
});

const classified = (results: unknown[]) =>
  json({
    results,
    rejected: 0,
    cached: false,
    provider: 'gemini',
    usage: { inputTokens: 1, outputTokens: 1 },
  });

const LIMIT = "You've reached today's AI limit.";

describe('AiClient', () => {
  it('endpoint names are unique', () => {
    const names = Object.values(AI_ENDPOINTS);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not call anything when the build has no cloud or the user is signed out', async () => {
    const f = fake(() => json({}));
    const noCloud = new AiClient({
      functionsUrl: null,
      getAccessToken: async () => 'x',
      fetch: f.fetch,
    });
    expect(await noCloud.health()).toMatchObject({ ok: false, reason: 'not_set_up' });
    expect(await client(f, null).health()).toMatchObject({ ok: false, reason: 'signed_out' });
    expect(f.calls).toHaveLength(0);
  });

  it('sends the user token and anon key, and validates the reply', async () => {
    const f = fake(() => json({ ok: true, providerConfigured: true, provider: 'gemini' }));
    const r = await client(f).health();
    expect(r).toEqual({
      ok: true,
      data: { ok: true, providerConfigured: true, provider: 'gemini' },
    });
    expect(f.calls[0]!.url).toBe('https://p.supabase.co/functions/v1/health');
    expect(f.calls[0]!.init.headers).toMatchObject({
      authorization: 'Bearer jwt-1',
      apikey: 'anon-1',
    });
  });

  it.each([
    [401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }, 'signed_out'],
    [429, { error: { code: 'RATE_LIMITED', message: LIMIT, scope: 'user' } }, 'limit_reached'],
    [503, { error: { code: 'AI_NOT_CONFIGURED', message: 'not set up' } }, 'no_provider'],
    [503, { error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }, 'unavailable'],
    [500, 'oops', 'unavailable'],
    [400, { error: { code: 'BAD_REQUEST', message: 'bad' } }, 'bad_reply'],
  ] as const)('maps HTTP %i to an offline reason', async (status, body, reason) => {
    const r = await client(fake(() => json(body, status))).health();
    expect(r).toMatchObject({ ok: false, reason });
  });

  it('keeps the server’s friendly limit message', async () => {
    const r = await client(
      fake(() => json({ error: { code: 'RATE_LIMITED', message: LIMIT } }, 429)),
    ).health();
    expect(r).toEqual({ ok: false, reason: 'limit_reached', message: LIMIT });
  });

  it('treats a malformed success, a network error and a timeout as offline', async () => {
    expect(await client(fake(() => json({ ok: 'yes' }))).health()).toMatchObject({
      reason: 'bad_reply',
    });
    const down = fake(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await client(down).health()).toMatchObject({ reason: 'unavailable' });
    const hang = fake(
      (_u, init) =>
        new Promise<Response>((_r, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    expect(await client(hang, 'jwt', 20).health()).toMatchObject({
      reason: 'unavailable',
      message: 'The AI took too long to answer.',
    });
  });
});

describe('createAiSeam', () => {
  it('stays offline and calls nothing while AI help is turned off', async () => {
    const f = fake(() => json({}));
    const seam = createAiSeam({ client: client(f), enabled: () => false });
    expect(await seam.resolveUnmapped([field()], { site: 'x.com', filled: {} })).toEqual(new Map());
    expect(seam.status()).toEqual({ mode: 'offline', reason: 'AI help is turned off' });
    expect(await seam.refreshStatus()).toMatchObject({ mode: 'offline' });
    expect(f.calls).toHaveLength(0);
  });

  it('sends minimised fields and turns results into mappings', async () => {
    const f = fake(() =>
      classified([
        {
          id: '0:f1',
          kind: 'fact',
          newKeySuggestion: 'custom.favourite_tools',
          confidence: 0.7,
          reason: 'Preferred tools',
          question: 'Which tools?',
        },
        {
          id: '0:f2',
          kind: 'fact',
          canonicalKey: 'projects[].name',
          confidence: 0.8,
          reason: 'A project name',
        },
        { id: '0:f3', kind: 'fact', canonicalKey: 'contact.email', confidence: 1, reason: 'Email' },
        { id: '0:f9', kind: 'fact', canonicalKey: 'contact.email', confidence: 1, reason: 'Other' },
      ]),
    );
    const seam = createAiSeam({
      client: client(f),
      enabled: () => true,
      policy: () => createPolicy({ extraPatterns: ['secret word'] }),
    });
    const fields = [
      field({ currentValue: 'VS Code, Figma' }),
      field({
        id: '0:f2',
        label: 'Second build',
        sectionHeading: 'Project 2',
        signature: 'b'.repeat(64),
      }),
      field({ id: '0:f3', label: 'Secret word', signature: 'c'.repeat(64) }),
    ];
    const out = await seam.resolveUnmapped(fields, {
      site: 'hack.example',
      title: 'Profile',
      filled: { 'person.name.full': 'Priya' },
      goal: { text: 'Join a hackathon', role: 'Developer' },
    });
    expect(Object.fromEntries(out)).toEqual({
      '0:f1': {
        kind: 'fact',
        canonicalKey: 'custom.favourite_tools',
        confidence: 0.7,
        reason: 'Preferred tools',
        source: 'ai',
        question: 'Which tools?',
      },
      '0:f2': {
        kind: 'fact',
        canonicalKey: 'projects[1].name',
        confidence: 0.8,
        reason: 'A project name',
        source: 'ai',
      },
      // 0:f3 is on the user's own deny list; 0:f9 was never asked about.
    });
    expect(seam.status()).toEqual({ mode: 'ai' });
    const sent = JSON.stringify(f.calls[0]!.body);
    for (const leak of ['VS Code', 'Priya', 'selector', 'signature'])
      expect(sent).not.toContain(leak);
    expect(f.calls[0]!.body).toMatchObject({
      page: { host: 'hack.example', title: 'Profile' },
      goal: { text: 'Join a hackathon', role: 'Developer' },
    });
  });

  it('on any failure returns nothing and says why (the flow continues through questions)', async () => {
    const seam = createAiSeam({
      client: client(fake(() => json({ error: { code: 'RATE_LIMITED', message: LIMIT } }, 429))),
      enabled: () => true,
    });
    expect((await seam.resolveUnmapped([field()], { site: 'x', filled: {} })).size).toBe(0);
    expect(seam.status()).toEqual({ mode: 'offline', reason: 'daily AI limit reached' });
    expect(seam.mode).toBe('offline');
    const answer = await seam.generateAnswer(
      field(),
      { kind: 'open_ended', confidence: 0, reason: '', source: 'none' },
      { site: 'x', filled: {} },
    );
    expect(answer).toHaveProperty('needsInput');
  });

  it('checks health at most once per TTL unless forced', async () => {
    let t = 0;
    const f = fake(() => json({ ok: true, providerConfigured: false, provider: null }));
    const seam = createAiSeam({
      client: client(f),
      enabled: () => true,
      now: () => t,
      statusTtlMs: 1000,
    });
    expect(await seam.refreshStatus()).toEqual({
      mode: 'offline',
      reason: 'AI is not set up on the server yet',
    });
    t = 500;
    await seam.refreshStatus();
    expect(f.calls).toHaveLength(1);
    await seam.refreshStatus(true);
    t = 5000;
    await seam.refreshStatus();
    expect(f.calls).toHaveLength(3);
  });
});

describe('generateAnswer (Phase 9)', () => {
  const ctx = {
    site: 'upwork.com',
    goal: {
      text: 'Upwork profile',
      role: 'business consultant',
      targetAudience: 'small businesses',
      language: 'Hindi',
    },
    filled: { 'bio.headline': 'SMB Consultant', 'contact.email': 'priya@example.com' },
    facts: [{ key: 'skills', value: ['Excel', 'SQL'] }],
    examples: [{ question: 'About you', answer: 'I help shops.' }],
    hint: 'shorter',
  };
  const overview = field({ label: 'Profile overview', inputType: 'textarea', maxLength: 200 });
  const reply = (body: Record<string, unknown>) =>
    json({
      alternatives: [],
      usedFacts: [],
      needsInput: [],
      charCount: 0,
      provider: 'gemini',
      usage: { inputTokens: 1, outputTokens: 1 },
      ...body,
    });

  it('sends the selected facts, goal and public filled values only', async () => {
    const f = fake(() => reply({ value: 'I use Excel and SQL.', usedFacts: ['skills'] }));
    const seam = createAiSeam({ client: client(f), enabled: () => true });
    const out = await seam.generateAnswer(
      overview,
      { kind: 'open_ended', confidence: 0, reason: '', source: 'none' },
      ctx,
    );
    expect(out).toMatchObject({ value: 'I use Excel and SQL.', usedFacts: ['skills'] });
    expect(f.calls[0]!.url).toBe('https://p.supabase.co/functions/v1/ai-generate');
    expect(f.calls[0]!.body).toMatchObject({
      goal: { role: 'business consultant', audience: 'small businesses', language: 'Hindi' },
      facts: [{ key: 'skills', value: ['Excel', 'SQL'] }],
      filled: [{ key: 'bio.headline', value: 'SMB Consultant' }],
      examples: [{ question: 'About you', answer: 'I help shops.' }],
      hint: 'shorter',
    });
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('priya@example.com');
  });

  it('re-checks the reply: an invented draft never comes back; questions do', async () => {
    const seam = createAiSeam({
      client: client(
        fake(() => reply({ value: 'I worked at Google.', alternatives: ['Excel is my tool.'] })),
      ),
      enabled: () => true,
    });
    const out = await seam.generateAnswer(
      overview,
      { kind: 'open_ended', confidence: 0, reason: '', source: 'none' },
      ctx,
    );
    expect(out).toMatchObject({ value: 'Excel is my tool.', alternatives: [] });
    const asks = createAiSeam({
      client: client(fake(() => reply({ needsInput: ['Which projects?'] }))),
      enabled: () => true,
    });
    expect(
      await asks.generateAnswer(
        overview,
        { kind: 'open_ended', confidence: 0, reason: '', source: 'none' },
        ctx,
      ),
    ).toMatchObject({ needsInput: 'Which projects?', questions: ['Which projects?'] });
  });
});
