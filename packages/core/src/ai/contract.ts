/**
 * The AI wire contract (PLAYBOOK Phase 8), shared by the extension's client
 * and the Edge Functions so there is exactly one definition of every body.
 *
 * `classify` carries field descriptors only: labels, options, help text and
 * the page host. Never a vault value, never the field's current value, and
 * never the user's own custom key names (they can reveal personal topics).
 * The server knows the canonical key registry itself.
 */
import { z } from 'zod';
import type { FieldDescriptor } from '../schema/records';
import { redactText } from './redact';

/** Bumped whenever the classify prompt or contract changes (part of the cache key). */
export const CLASSIFY_PROMPT_VERSION = 'classify-v1';
/** Fields per model call; bigger requests are split into chunks of this size. */
export const CLASSIFY_CHUNK = 40;
/** Fields per request from the client. */
export const CLASSIFY_MAX_FIELDS = 120;

const text = (max: number) => z.string().max(max);

/** A field as the AI sees it: minimised and redacted. */
export const AiFieldSchema = z
  .object({
    id: z.string().min(1).max(64),
    inputType: text(64),
    label: text(300),
    placeholder: text(200).optional(),
    helpText: text(400).optional(),
    sectionHeading: text(200).optional(),
    options: z.array(text(120)).max(60).optional(),
    multiple: z.boolean().optional(),
    required: z.boolean(),
    maxLength: z.number().int().positive().optional(),
  })
  .strict();
export type AiField = z.infer<typeof AiFieldSchema>;

export const AiGoalSchema = z
  .object({
    text: text(500),
    platform: text(253).optional(),
    role: text(200).optional(),
  })
  .strict();
export type AiGoal = z.infer<typeof AiGoalSchema>;

export const ClassifyRequestSchema = z
  .object({
    fields: z.array(AiFieldSchema).min(1).max(CLASSIFY_MAX_FIELDS),
    page: z.object({ host: text(253), title: text(200).optional() }).strict(),
    goal: AiGoalSchema.optional(),
  })
  .strict();
export type ClassifyRequest = z.infer<typeof ClassifyRequestSchema>;

export const AI_FIELD_KINDS = ['fact', 'open_ended', 'choice', 'skip'] as const;

/** One field's classification, as the model must return it (strict: no extra keys). */
export const ClassifiedFieldSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(AI_FIELD_KINDS),
    /** A canonical registry key (`contact.email`, `projects[].name` or `projects[1].name`). */
    canonicalKey: z.string().max(80).optional(),
    /** For facts the registry lacks: a `custom.<slug>` name for the user's vault. */
    newKeySuggestion: z.string().max(60).optional(),
    confidence: z.number().min(0).max(1),
    /** Short plain-English reason, shown in the review list. */
    reason: z.string().min(1).max(200),
    /** How to ask the user, when the vault has no answer. */
    question: z.string().max(200).optional(),
  })
  .strict();
export type ClassifiedField = z.infer<typeof ClassifiedFieldSchema>;

/** What the model must produce (validated before anything else looks at it). */
export const ClassifyModelOutputSchema = z
  .object({ fields: z.array(ClassifiedFieldSchema).max(CLASSIFY_CHUNK) })
  .strict();

export const AiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

export const ClassifyResponseSchema = z.object({
  results: z.array(ClassifiedFieldSchema),
  /** Items the safety checks dropped (unknown ids, URLs, actions, denied fields…). */
  rejected: z.number().int().nonnegative(),
  cached: z.boolean(),
  provider: z.string().nullable(),
  usage: AiUsageSchema,
});
export type ClassifyResponse = z.infer<typeof ClassifyResponseSchema>;

export const AI_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN_ORIGIN',
  'METHOD_NOT_ALLOWED',
  'BAD_REQUEST',
  'RATE_LIMITED',
  'AI_NOT_CONFIGURED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export const AiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** For RATE_LIMITED: whose limit was reached. */
    scope: z.enum(['user', 'global']).optional(),
  }),
});

export const QuotaLimitsSchema = z.object({
  maxCalls: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
});

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  providerConfigured: z.boolean(),
  provider: z.string().nullable(),
  /** Today's per-user limits for each AI endpoint (not secret). */
  limits: z.record(z.string(), QuotaLimitsSchema).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const clip = (value: string | undefined, max: number): string | undefined => {
  const t = value?.replace(/\s+/g, ' ').trim();
  return t ? redactText(t).slice(0, max) : undefined;
};

/**
 * Turns a scanned field into what the AI may see: no current value, no
 * selector, no DOM ids, no signature; texts trimmed and redacted.
 */
export function toAiField(field: FieldDescriptor): AiField {
  const options = field.options
    ?.map((o) => clip(o.text || o.value, 120))
    .filter((o): o is string => Boolean(o))
    .slice(0, 60);
  const out: AiField = {
    id: field.id.slice(0, 64),
    inputType: field.inputType.slice(0, 64),
    label: clip(field.label, 300) ?? '',
    required: field.required,
  };
  const placeholder = clip(field.placeholder, 200);
  const helpText = clip(field.helpText, 400);
  const sectionHeading = clip(field.sectionHeading, 200);
  if (placeholder) out.placeholder = placeholder;
  if (helpText) out.helpText = helpText;
  if (sectionHeading) out.sectionHeading = sectionHeading;
  if (options?.length) out.options = options;
  if (field.multiple) out.multiple = true;
  if (field.maxLength) out.maxLength = field.maxLength;
  return out;
}
