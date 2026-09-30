/**
 * Messages between the side panel, the background worker and the page agent.
 * Every message and response is validated with Zod on receipt.
 */
import { FieldDescriptorSchema } from '@filler/core';
import { z } from 'zod';

const tabId = z.number().int().nonnegative();

export const GetTargetTabRequestSchema = z.object({
  type: z.literal('GET_TARGET_TAB'),
  /** Set when the panel runs as a normal tab (dev/tests), so it never targets itself. */
  selfTabId: tabId.optional(),
});

export const ScanRequestSchema = z.object({
  type: z.literal('SCAN_REQUEST'),
  tabId,
});

export const PanelRequestSchema = z.discriminatedUnion('type', [
  GetTargetTabRequestSchema,
  ScanRequestSchema,
]);
export type PanelRequest = z.infer<typeof PanelRequestSchema>;

export const TargetTabSchema = z.object({
  tabId,
  /** Only known when Filler has access to the tab (activeTab or granted site access). */
  url: z.string().optional(),
  title: z.string().optional(),
});
export type TargetTab = z.infer<typeof TargetTabSchema>;

/** What one frame's page agent returns. */
export const FrameScanSchema = z.object({
  url: z.string(),
  title: z.string(),
  scannedAt: z.string(),
  fields: z.array(FieldDescriptorSchema),
  errors: z.array(z.string()),
});
export type FrameScan = z.infer<typeof FrameScanSchema>;

/** A whole tab, all frames merged. */
export const PageScanSchema = z.object({
  tabId,
  url: z.string(),
  title: z.string(),
  scannedAt: z.string(),
  frames: z.number().int().positive(),
  fields: z.array(FieldDescriptorSchema),
  errors: z.array(z.string()),
});
export type PageScan = z.infer<typeof PageScanSchema>;

export const ERROR_CODES = [
  'BAD_REQUEST',
  'NO_TAB',
  'NO_PERMISSION',
  'RESTRICTED_PAGE',
  'INJECTION_FAILED',
  'SCAN_FAILED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const ErrorSchema = z.object({ code: z.enum(ERROR_CODES), message: z.string() });

export function resultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ErrorSchema }),
  ]);
}

export type Result<T> =
  { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = <T = never>(code: ErrorCode, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});

/** Optional host permissions the user can grant from the panel (manifest optional_host_permissions). */
export const SITE_ACCESS = { origins: ['http://*/*', 'https://*/*'] };
