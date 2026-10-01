import { Banner, Button, Card, Spinner, Toggle } from '@filler/ui';
import { useCallback, useEffect, useState } from 'react';
import { call } from '@/src/messaging/client';
import type { AuthStatus } from '@/src/cloud/auth';
import type { AiTestResult, AiUsage } from '@/src/messaging/protocol';
import { AiChip } from '../AiChip';
import { usePanel } from '../store';

const ENDPOINT_NAMES: Record<string, string> = {
  'ai-classify': 'Understanding fields',
  'ai-generate': 'Writing answers',
  'ai-vision': 'Reading the screen',
  'ai-extract': 'Reading résumés',
};

const n = (v: number) => v.toLocaleString('en-IN');

/** Settings → AI help (PLAYBOOK Tasks 8.4–8.5): on/off, connection check, today's usage. */
export function AiCard() {
  const settings = usePanel((s) => s.settings);
  const update = usePanel((s) => s.updateSettings);
  const refreshAi = usePanel((s) => s.refreshAi);
  const authVersion = usePanel((s) => s.authVersion);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [usageNote, setUsageNote] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    const auth = await call<AuthStatus>({ type: 'AUTH_STATUS' });
    if (!auth.ok || !auth.data.configured) {
      setUsage(null);
      setUsageNote('Cloud features are not set up in this build, so AI is not available.');
      return;
    }
    if (!auth.data.signedIn) {
      setUsage(null);
      setUsageNote('Sign in (above) to use AI and see your usage.');
      return;
    }
    const result = await call<AiUsage>({ type: 'AI_USAGE' });
    if (result.ok) {
      setUsage(result.data);
      setUsageNote(null);
    } else {
      setUsage(null);
      setUsageNote(result.error.message);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage, authVersion]);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    const result = await call<AiTestResult>({ type: 'AI_TEST' });
    setTesting(false);
    setTest(
      result.ok
        ? result.data
        : { ok: false, message: result.error.message, provider: null, latencyMs: 0 },
    );
    await refreshAi();
    await loadUsage();
  };

  return (
    <Card className="space-y-3" data-testid="ai-card">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">AI help</h3>
        <AiChip />
      </div>
      <Toggle
        label="Use AI to understand new fields"
        description="Only the page's field labels, options and help text are sent, never your details. Needs sign-in. Off: Filler asks you instead."
        checked={settings.aiAssist}
        onChange={(v) => void update({ aiAssist: v })}
      />
      <Button
        variant="secondary"
        onClick={() => void runTest()}
        disabled={testing || !settings.aiAssist}
      >
        {testing ? 'Testing…' : 'Test AI connection'}
      </Button>
      {testing && <Spinner label="Asking Filler's server…" />}
      {test && (
        <Banner tone={test.ok ? 'green' : 'amber'} role="status" data-testid="ai-test-result">
          {test.message}
        </Banner>
      )}

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
          Usage today
        </h4>
        {usageNote && <p className="text-xs text-slate-600 dark:text-slate-400">{usageNote}</p>}
        {usage && (
          <table className="w-full text-xs" data-testid="ai-usage">
            <caption className="sr-only">AI calls and tokens used today ({usage.day}, UTC)</caption>
            <thead>
              <tr className="text-left text-slate-600 dark:text-slate-400">
                <th scope="col" className="py-1 font-medium">
                  Feature
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Calls
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.endpoints.map((e) => (
                <tr key={e.endpoint} className="border-t border-slate-200 dark:border-slate-800">
                  <th scope="row" className="py-1 text-left font-normal">
                    {ENDPOINT_NAMES[e.endpoint] ?? e.endpoint}
                  </th>
                  <td className="py-1 text-right tabular-nums">
                    {n(e.calls)}
                    {e.maxCalls !== undefined && ` / ${n(e.maxCalls)}`}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {n(e.tokens)}
                    {e.maxTokens ? ` / ${n(e.maxTokens)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
