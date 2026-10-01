/**
 * `vision` wire contract (PLAYBOOK Task 10.2) and its output checks, shared
 * by the Edge Function and the extension.
 *
 * The image is a single frame the user chose, previewed and blurred on the
 * device. Text in the image is untrusted exactly like page text: the model
 * may only describe fields, never steer Filler.
 */
import { z } from 'zod';
import { AiUsageSchema } from '../ai/contract';
import { isRegistryKey, isUnsafeText } from '../ai/guard';
import { redactText } from '../ai/redact';
import { classifyRisk, type Policy } from '../policy/deny';

export const VISION_PROMPT_VERSION = 'vision-v1';
/** Longest image edge sent to the AI. */
export const VISION_MAX_EDGE = 1600;
/** Base64 JPEG size cap (≈ 2.2 MB of image). */
export const VISION_MAX_BASE64 = 3_000_000;

const text = (max: number) => z.string().max(max);

export const BoxSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
export type Box = z.infer<typeof BoxSchema>;

export const VisionRequestSchema = z
  .object({
    image: z
      .object({
        mimeType: z.literal('image/jpeg'),
        data: z
          .string()
          .min(100)
          .max(VISION_MAX_BASE64)
          .regex(/^[A-Za-z0-9+/]+=*$/),
        width: z.number().int().positive().max(VISION_MAX_EDGE),
        height: z.number().int().positive().max(VISION_MAX_EDGE),
      })
      .strict(),
    /** `tab`: a browser tab; `screen`: a shared screen or window; `region`: one user-drawn area. */
    mode: z.enum(['tab', 'screen', 'region']),
    page: z
      .object({ host: text(253).optional(), title: text(200).optional() })
      .strict()
      .optional(),
    goal: z
      .object({ text: text(500), role: text(200).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type VisionRequest = z.infer<typeof VisionRequestSchema>;

export const VISION_KINDS = ['fact', 'open_ended', 'choice', 'skip', 'denied'] as const;

export const VisionFieldSchema = z
  .object({
    id: text(40),
    label: z.string().min(1).max(200),
    kind: z.enum(VISION_KINDS),
    /** In image pixels. */
    bbox: BoxSchema,
    options: z.array(text(120)).max(60).optional(),
    canonicalKey: text(80).optional(),
    /** Plain-English note about the field (shown in "What is this?"). */
    hint: text(200).optional(),
  })
  .strict();
export type VisionField = z.infer<typeof VisionFieldSchema>;

export const VisionModelOutputSchema = z
  .object({
    formPurpose: text(200),
    fields: z.array(z.unknown()).max(80),
    warnings: z.array(text(200)).max(10),
  })
  .strict();

export const VisionResponseSchema = z.object({
  formPurpose: z.string(),
  fields: z.array(VisionFieldSchema),
  warnings: z.array(z.string()),
  rejected: z.number().int().nonnegative(),
  provider: z.string().nullable(),
  usage: AiUsageSchema,
});
export type VisionResponse = z.infer<typeof VisionResponseSchema>;

const clean = (s: string, max: number) => redactText(s.replace(/\s+/g, ' ').trim()).slice(0, max);

/**
 * Checks a model's reply: every field is validated on its own, texts are
 * redacted, boxes are clamped to the image, keys must be real, anything the
 * deny policy refuses comes back as `denied`, and purpose/warnings that try
 * to steer the user (links, "click…") are dropped.
 */
export function guardVision(
  raw: { formPurpose: string; fields: unknown[]; warnings: string[] },
  size: { width: number; height: number },
  policy: Pick<Policy, 'classifyRisk'> = { classifyRisk },
): { formPurpose: string; fields: VisionField[]; warnings: string[]; rejected: number } {
  let rejected = 0;
  const fields: VisionField[] = [];
  const seen = new Set<string>();
  for (const entry of raw.fields) {
    const parsed = VisionFieldSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) {
      rejected++;
      continue;
    }
    const f = parsed.data;
    const label = clean(f.label, 200);
    if (!label || isUnsafeText(label) || (f.hint && isUnsafeText(f.hint))) {
      rejected++;
      continue;
    }
    seen.add(f.id);
    const x = Math.min(Math.max(0, f.bbox.x), size.width);
    const y = Math.min(Math.max(0, f.bbox.y), size.height);
    const out: VisionField = {
      id: f.id,
      label,
      kind: f.kind,
      bbox: {
        x,
        y,
        width: Math.min(f.bbox.width, size.width - x),
        height: Math.min(f.bbox.height, size.height - y),
      },
    };
    const options = f.options?.map((o) => clean(o, 120)).filter(Boolean);
    if (options?.length) out.options = options;
    if (f.hint) out.hint = clean(f.hint, 200);
    const risk = policy.classifyRisk({ inputType: 'text', label });
    if (!risk.allowed || f.kind === 'denied') {
      out.kind = 'denied';
      out.hint = risk.allowed
        ? (out.hint ?? 'Filler never fills this kind of field.')
        : risk.reason;
    } else if (f.canonicalKey && isRegistryKey(f.canonicalKey) && f.kind !== 'skip') {
      out.canonicalKey = f.canonicalKey;
    }
    fields.push(out);
  }
  const safe = (s: string) => !isUnsafeText(s);
  return {
    formPurpose: safe(raw.formPurpose) ? clean(raw.formPurpose, 200) : 'A form',
    fields,
    warnings: raw.warnings.filter(safe).map((w) => clean(w, 200)),
    rejected,
  };
}
