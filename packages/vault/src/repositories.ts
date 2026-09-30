/**
 * Typed repositories over the encrypted tables. Every record is validated
 * with the core Zod schema on write and on read.
 */
import {
  AnswerSchema,
  DocumentRecordSchema,
  FactSchema,
  FieldMemorySchema,
  classifyRisk,
  detectSensitiveValue,
  getKeyDef,
  isCustomKey,
  normaliseLabel,
  parseKey,
  siteOf,
  type Answer,
  type DocumentRecord,
  type Fact,
  type FactValue,
  type FieldMemory,
  type Sensitivity,
} from '@filler/core';
import type { ZodType } from 'zod';
import { VaultValidationError } from './errors';
import type { VaultService } from './service';

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, personal: 1, restricted: 2 };

function parseOrThrow<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new VaultValidationError(
      `Invalid ${what}: ${issue?.path.join('.') || 'value'} ${issue?.message ?? ''}`.trim(),
    );
  }
  return result.data;
}

/** Default sensitivity for a key: the registry's, or `public` for custom keys. */
export function defaultSensitivity(key: string): Sensitivity {
  return getKeyDef(key)?.sensitivity ?? 'public';
}

/** Throws if a fact must never be stored (sensitive value, denied custom key, sensitivity downgrade). */
export function assertFactAllowed(fact: Fact): void {
  const values = Array.isArray(fact.value) ? fact.value : [fact.value];
  for (const value of values) {
    const category = detectSensitiveValue(value);
    if (category) {
      throw new VaultValidationError(
        `This looks like a ${category.replace(/_/g, ' ')}. Filler never stores that kind of value.`,
      );
    }
  }
  if (isCustomKey(fact.key)) {
    const risk = classifyRisk({
      inputType: 'text',
      label: fact.key.slice('custom.'.length).replace(/_/g, ' '),
    });
    if (!risk.allowed) throw new VaultValidationError(risk.reason);
  }
  const floor = defaultSensitivity(fact.key);
  if (SENSITIVITY_RANK[fact.sensitivity] < SENSITIVITY_RANK[floor]) {
    throw new VaultValidationError(
      `"${getKeyDef(fact.key)?.label ?? fact.key}" must be at least ${floor}; it cannot be marked ${fact.sensitivity}.`,
    );
  }
}

export class FactRepo {
  constructor(private readonly vault: VaultService) {}

  async get(key: string): Promise<Fact | undefined> {
    const value = await this.vault.readRecord<unknown>('facts', key);
    return value === undefined ? undefined : parseOrThrow(FactSchema, value, 'fact');
  }

  async set(fact: Fact): Promise<Fact> {
    const parsed = parseOrThrow(FactSchema, fact, 'fact');
    assertFactAllowed(parsed);
    await this.vault.writeRecord('facts', parsed.key, parsed);
    return parsed;
  }

  /** Convenience writer that fills in sensitivity, source and timestamp. */
  setValue(
    key: string,
    value: FactValue,
    options: { sensitivity?: Sensitivity; source?: Fact['source']; learnedOn?: string } = {},
  ): Promise<Fact> {
    return this.set({
      key,
      value,
      sensitivity: options.sensitivity ?? defaultSensitivity(key),
      source: options.source ?? 'user',
      ...(options.learnedOn ? { learnedOn: siteOf(options.learnedOn) } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  async list(): Promise<Fact[]> {
    const all = await this.vault.readAll<unknown>('facts');
    return all
      .map((v) => parseOrThrow(FactSchema, v, 'fact'))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async byGroup(group: string): Promise<Fact[]> {
    return (await this.list()).filter((f) => parseKey(f.key)?.group === group);
  }

  delete(key: string): Promise<void> {
    return this.vault.deleteRecord('facts', key);
  }
}

export class DocumentRepo {
  constructor(private readonly vault: VaultService) {}

  async put(doc: DocumentRecord): Promise<DocumentRecord> {
    const parsed = parseOrThrow(DocumentRecordSchema, doc, 'document');
    await this.vault.writeRecord('documents', parsed.id, parsed);
    return parsed;
  }

  async get(id: string): Promise<DocumentRecord | undefined> {
    const value = await this.vault.readRecord<unknown>('documents', id);
    return value === undefined ? undefined : parseOrThrow(DocumentRecordSchema, value, 'document');
  }

  async list(): Promise<DocumentRecord[]> {
    return (await this.vault.readAll<unknown>('documents')).map((v) =>
      parseOrThrow(DocumentRecordSchema, v, 'document'),
    );
  }

  delete(id: string): Promise<void> {
    return this.vault.deleteRecord('documents', id);
  }
}

export class FieldMemoryRepo {
  constructor(private readonly vault: VaultService) {}

  async get(signature: string): Promise<FieldMemory | undefined> {
    const value = await this.vault.readRecord<unknown>('fieldMemory', signature);
    return value === undefined ? undefined : parseOrThrow(FieldMemorySchema, value, 'field memory');
  }

  /** Creates or updates the memory for a field and bumps its usage count. */
  async upsert(entry: {
    signature: string;
    site: string;
    canonicalKey?: string;
    lastAnswerId?: string;
  }): Promise<FieldMemory> {
    const existing = await this.get(entry.signature);
    const next = parseOrThrow(
      FieldMemorySchema,
      {
        ...existing,
        ...entry,
        site: siteOf(entry.site),
        timesUsed: (existing?.timesUsed ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      },
      'field memory',
    );
    await this.vault.writeRecord('fieldMemory', next.signature, next);
    return next;
  }

  async list(): Promise<FieldMemory[]> {
    return (await this.vault.readAll<unknown>('fieldMemory')).map((v) =>
      parseOrThrow(FieldMemorySchema, v, 'field memory'),
    );
  }

  /** Forgets everything learned on one site. Returns how many entries were removed. */
  async deleteBySite(site: string): Promise<number> {
    const target = siteOf(site);
    const ids = (await this.list()).filter((m) => m.site === target).map((m) => m.signature);
    await this.vault.deleteRecords('fieldMemory', ids);
    return ids.length;
  }
}

function tokens(text: string): Set<string> {
  return new Set(
    normaliseLabel(text)
      .split(' ')
      .filter((t) => t.length > 1),
  );
}

/** Token-set Jaccard similarity, 0–1. */
export function questionSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export class AnswerRepo {
  constructor(private readonly vault: VaultService) {}

  async add(answer: Answer): Promise<Answer> {
    const parsed = parseOrThrow(AnswerSchema, answer, 'answer');
    await this.vault.writeRecord('answers', parsed.id, parsed);
    return parsed;
  }

  async get(id: string): Promise<Answer | undefined> {
    const value = await this.vault.readRecord<unknown>('answers', id);
    return value === undefined ? undefined : parseOrThrow(AnswerSchema, value, 'answer');
  }

  async list(): Promise<Answer[]> {
    return (await this.vault.readAll<unknown>('answers')).map((v) =>
      parseOrThrow(AnswerSchema, v, 'answer'),
    );
  }

  /**
   * Previously approved answers to similar questions, best first. Answers from
   * the same platform rank above equally similar ones from elsewhere.
   */
  async search(
    question: string,
    options: { platform?: string; minScore?: number; limit?: number } = {},
  ) {
    const { platform, minScore = 0.5, limit = 5 } = options;
    const target = platform ? siteOf(platform) : undefined;
    return (await this.list())
      .map((answer) => {
        const score = questionSimilarity(question, answer.questionText);
        const samePlatform = target !== undefined && siteOf(answer.platform) === target;
        return { answer, score, samePlatform };
      })
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score || Number(b.samePlatform) - Number(a.samePlatform))
      .slice(0, limit);
  }

  delete(id: string): Promise<void> {
    return this.vault.deleteRecord('answers', id);
  }
}

/** All repositories over one vault. */
export function createRepositories(vault: VaultService) {
  return {
    facts: new FactRepo(vault),
    documents: new DocumentRepo(vault),
    fieldMemory: new FieldMemoryRepo(vault),
    answers: new AnswerRepo(vault),
  };
}
export type Repositories = ReturnType<typeof createRepositories>;
