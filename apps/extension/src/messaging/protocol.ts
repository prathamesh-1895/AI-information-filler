/**
 * Messages between the side panel, the background worker and the page agent.
 * Every message and response is validated with Zod on receipt.
 */
import {
  FactValueSchema,
  FieldDescriptorSchema,
  GoalSchema,
  SensitivitySchema,
  UserEventSchema,
  type SessionState,
} from '@filler/core';
import { z } from 'zod';
import { SettingsPatchSchema } from '../settings';

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

/** Page-wide field id: `<frameId>:<frame-local id>`, e.g. `0:f3`. */
export const FieldIdSchema = z.string().regex(/^\d+:[a-z]\d+$/);

export const FillItemSchema = z.object({
  fieldId: FieldIdSchema,
  selector: z.string().max(2_000),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
  value: FactValueSchema,
  mode: z.enum(['auto', 'typing']).optional(),
});
export type FillItem = z.infer<typeof FillItemSchema>;

export const FillRequestSchema = z.object({
  type: z.literal('FILL_REQUEST'),
  tabId,
  items: z.array(FillItemSchema).min(1).max(500),
});

export const FillResultSchema = z.object({
  fieldId: FieldIdSchema,
  status: z.enum(['filled', 'failed']),
  finalValue: z.union([z.string(), z.array(z.string())]).optional(),
  error: z.string().optional(),
  method: z.string().optional(),
});
export type FillResult = z.infer<typeof FillResultSchema>;

export const HIGHLIGHT_STATES = ['vault', 'ai', 'input', 'denied', 'filled', 'failed'] as const;
export const HighlightItemSchema = z.object({
  fieldId: FieldIdSchema,
  state: z.enum(HIGHLIGHT_STATES),
  title: z.string().max(200).optional(),
  preview: z.string().max(300).optional(),
});
export type HighlightItem = z.infer<typeof HighlightItemSchema>;

export const HighlightRequestSchema = z.object({
  type: z.literal('HIGHLIGHT_REQUEST'),
  tabId,
  items: z.array(HighlightItemSchema).max(500),
});

export const ObserveRequestSchema = z.object({ type: z.literal('OBSERVE_REQUEST'), tabId });
export const EndSessionRequestSchema = z.object({ type: z.literal('END_SESSION_REQUEST'), tabId });
export const NavListRequestSchema = z.object({ type: z.literal('NAV_LIST_REQUEST'), tabId });
export const NavClickRequestSchema = z.object({
  type: z.literal('NAV_CLICK_REQUEST'),
  tabId,
  buttonId: z.string().regex(/^\d+:b\d+$/),
});

export const NavButtonSchema = z.object({
  buttonId: z.string(),
  text: z.string(),
  submitLike: z.boolean(),
});
export type NavButton = z.infer<typeof NavButtonSchema>;

// ---- Vault (Phase 5): the vault lives in the background worker only.
const passphrase = z.string().min(1).max(1_000);
export const VaultStatusRequestSchema = z.object({ type: z.literal('VAULT_STATUS') });
export const VaultCreateRequestSchema = z.object({ type: z.literal('VAULT_CREATE'), passphrase });
export const VaultUnlockRequestSchema = z.object({ type: z.literal('VAULT_UNLOCK'), passphrase });
export const VaultLockRequestSchema = z.object({ type: z.literal('VAULT_LOCK') });
export const FactSetRequestSchema = z.object({
  type: z.literal('FACT_SET'),
  key: z.string().max(200),
  value: FactValueSchema,
  sensitivity: SensitivitySchema.optional(),
});
export const FactDeleteRequestSchema = z.object({
  type: z.literal('FACT_DELETE'),
  key: z.string().max(200),
});
export const FactListRequestSchema = z.object({ type: z.literal('FACT_LIST') });
/** Several fact writes/deletes in one request (quick-start profile, reordering list items). */
export const FactBatchRequestSchema = z.object({
  type: z.literal('FACT_BATCH'),
  set: z
    .array(
      z.object({
        key: z.string().max(200),
        value: FactValueSchema,
        sensitivity: SensitivitySchema.optional(),
      }),
    )
    .max(500),
  remove: z.array(z.string().max(200)).max(500),
});
export const VaultExportRequestSchema = z.object({ type: z.literal('VAULT_EXPORT') });
export const VaultImportRequestSchema = z.object({
  type: z.literal('VAULT_IMPORT'),
  json: z.string().max(20_000_000),
  passphrase,
});
/** Typed confirmation guards the irreversible wipe. */
export const VaultWipeRequestSchema = z.object({
  type: z.literal('VAULT_WIPE'),
  confirm: z.literal('DELETE'),
});
export const MemoryClearSiteRequestSchema = z.object({
  type: z.literal('MEMORY_CLEAR_SITE'),
  site: z.string().min(1).max(253),
});
// ---- Account and sync (Phase 7)
export const AuthStatusRequestSchema = z.object({ type: z.literal('AUTH_STATUS') });
export const AuthSendCodeRequestSchema = z.object({
  type: z.literal('AUTH_SEND_CODE'),
  email: z.string().max(254),
});
export const AuthVerifyRequestSchema = z.object({
  type: z.literal('AUTH_VERIFY'),
  email: z.string().max(254),
  code: z.string().max(12),
});
export const AuthSignOutRequestSchema = z.object({ type: z.literal('AUTH_SIGN_OUT') });
export const SyncStatusRequestSchema = z.object({ type: z.literal('SYNC_STATUS') });
export const SyncNowRequestSchema = z.object({ type: z.literal('SYNC_NOW') });
export const SyncUseCloudRequestSchema = z.object({
  type: z.literal('SYNC_USE_CLOUD'),
  passphrase,
});
export const SyncReplaceCloudRequestSchema = z.object({ type: z.literal('SYNC_REPLACE_CLOUD') });
// ---- AI (Phase 8)
export const AiStatusRequestSchema = z.object({
  type: z.literal('AI_STATUS'),
  /** Re-check the backend now instead of using a recent answer. */
  refresh: z.boolean().optional(),
});
export const AiTestRequestSchema = z.object({ type: z.literal('AI_TEST') });
export const AiUsageRequestSchema = z.object({ type: z.literal('AI_USAGE') });
export const SettingsGetRequestSchema = z.object({ type: z.literal('SETTINGS_GET') });
export const SettingsSetRequestSchema = z.object({
  type: z.literal('SETTINGS_SET'),
  patch: SettingsPatchSchema,
});

// ---- Fill sessions (Phase 5): the orchestrator runs in the background, one session per tab.
export const SessionStartRequestSchema = z.object({
  type: z.literal('SESSION_START'),
  tabId,
  goal: GoalSchema.optional(),
});
export const SessionGetRequestSchema = z.object({ type: z.literal('SESSION_GET'), tabId });
export const SessionEventRequestSchema = z.object({
  type: z.literal('SESSION_EVENT'),
  tabId,
  event: UserEventSchema,
});

export const PanelRequestSchema = z.discriminatedUnion('type', [
  GetTargetTabRequestSchema,
  ScanRequestSchema,
  FillRequestSchema,
  HighlightRequestSchema,
  ObserveRequestSchema,
  EndSessionRequestSchema,
  NavListRequestSchema,
  NavClickRequestSchema,
  VaultStatusRequestSchema,
  VaultCreateRequestSchema,
  VaultUnlockRequestSchema,
  VaultLockRequestSchema,
  FactSetRequestSchema,
  FactDeleteRequestSchema,
  FactListRequestSchema,
  FactBatchRequestSchema,
  VaultExportRequestSchema,
  VaultImportRequestSchema,
  VaultWipeRequestSchema,
  MemoryClearSiteRequestSchema,
  SettingsGetRequestSchema,
  SettingsSetRequestSchema,
  AuthStatusRequestSchema,
  AuthSendCodeRequestSchema,
  AuthVerifyRequestSchema,
  AuthSignOutRequestSchema,
  SyncStatusRequestSchema,
  SyncNowRequestSchema,
  SyncUseCloudRequestSchema,
  SyncReplaceCloudRequestSchema,
  AiStatusRequestSchema,
  AiTestRequestSchema,
  AiUsageRequestSchema,
  SessionStartRequestSchema,
  SessionGetRequestSchema,
  SessionEventRequestSchema,
]);
export type PanelRequest = z.infer<typeof PanelRequestSchema>;

/** Events a page agent sends to the panel (frame-local ids; the panel adds the frame prefix). */
export const FieldsChangedEventSchema = z.object({
  type: z.literal('FIELDS_CHANGED'),
  reason: z.enum(['mutation', 'navigation']),
  url: z.string(),
  added: z.array(FieldDescriptorSchema),
  removed: z.array(z.string()),
});
export type FieldsChangedEvent = z.infer<typeof FieldsChangedEventSchema>;

export const FieldFocusedEventSchema = z.object({
  type: z.literal('FIELD_FOCUSED'),
  id: z.string(),
});

export const PageEventSchema = z.discriminatedUnion('type', [
  FieldsChangedEventSchema,
  FieldFocusedEventSchema,
]);
export type PageEvent = z.infer<typeof PageEventSchema>;

/** Splits `0:f3` into its frame id and frame-local id. */
export function splitId(id: string): { frameId: number; localId: string } {
  const at = id.indexOf(':');
  return { frameId: Number(id.slice(0, at)), localId: id.slice(at + 1) };
}

export const joinId = (frameId: number, localId: string) => `${frameId}:${localId}`;

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
  /** Filler refused on safety grounds (e.g. a submit-like button). */
  'REFUSED',
  'VAULT_LOCKED',
  'VAULT_MISSING',
  'VAULT_EXISTS',
  'WRONG_PASSPHRASE',
  /** A vault write was refused (denied value, weak passphrase, invalid fact). */
  'INVALID',
  'NO_SESSION',
  /** Cloud (sign-in or sync) problems. */
  'CLOUD',
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

/** Broadcast from the background to the panel after every session change. */
export interface SessionStateMessage {
  type: 'SESSION_STATE';
  tabId: number;
  state: SessionState;
}

export const SessionStateMessageSchema = z.object({
  type: z.literal('SESSION_STATE'),
  tabId,
  state: z.object({ id: z.string(), phase: z.string(), plan: z.array(z.unknown()) }).loose(),
});

/** Result of Settings → "Test AI connection". */
export const AiTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  provider: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;

/** Today's AI usage for the signed-in user, per endpoint, with the limits. */
export const AiUsageSchema = z.object({
  day: z.string(),
  endpoints: z.array(
    z.object({
      endpoint: z.string(),
      calls: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      maxCalls: z.number().int().nonnegative().optional(),
      maxTokens: z.number().int().nonnegative().optional(),
    }),
  ),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;
