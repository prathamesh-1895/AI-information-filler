/** Supabase Edge Function names the client will call (Phases 8–10). */
export const AI_ENDPOINTS = {
  health: 'health',
  classify: 'ai-classify',
  generate: 'ai-generate',
  vision: 'ai-vision',
} as const;

export type AiEndpoint = (typeof AI_ENDPOINTS)[keyof typeof AI_ENDPOINTS];
