/**
 * "Import a résumé or profile" (PLAYBOOK Task 11.1): pick a file or paste
 * text, see every detail Filler found, tick what to save. Nothing is saved
 * without this review, and changes to saved details are never pre-ticked.
 */
import type { FactValue, ImportRow } from '@filler/core';
import { Badge, Banner, Button, Card, Spinner, TextArea } from '@filler/ui';
import { FileUp } from 'lucide-react';
import { useState } from 'react';
import { call } from '@/src/messaging/client';
import type { ImportAnalysis } from '@/src/import/ops';
import { readResumeFile } from '@/src/import/read-file';
import { asText } from '../format';

interface Row extends ImportRow {
  draft: string;
}

const STATUS: Record<
  ImportRow['status'],
  { label: string; tone: 'green' | 'neutral' | 'amber' | 'blue' }
> = {
  new: { label: 'New', tone: 'green' },
  same: { label: 'Already saved', tone: 'neutral' },
  different: { label: 'Different from saved', tone: 'amber' },
  adds: { label: 'Adds to saved', tone: 'blue' },
};

const toValue = (row: Row): FactValue =>
  Array.isArray(row.value)
    ? row.draft
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : row.draft.trim();

export function ImportCard({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy('Reading the file on this device…');
    try {
      setText(await readResumeFile(file));
      setFileName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const analyze = async () => {
    setError(null);
    setDone(null);
    setBusy('Finding your details…');
    const r = await call<ImportAnalysis>({ type: 'IMPORT_ANALYZE', text });
    setBusy(null);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    setRows(r.data.rows.map((row) => ({ ...row, draft: asText(row.value) })));
    setNote(
      r.data.mode === 'ai'
        ? 'Read with Filler’s AI. Contact details were found on this device and not sent.'
        : (r.data.note ?? null),
    );
  };

  const save = async () => {
    if (!rows) return;
    const facts = rows
      .filter((r) => r.accept && r.draft.trim())
      .map((r) => ({ key: r.key, value: toValue(r) }));
    setBusy('Saving…');
    const r = await call<{ saved: number }>({
      type: 'IMPORT_SAVE',
      facts,
      text,
      fileName: fileName || 'Pasted text',
    });
    setBusy(null);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    setDone(
      `Saved ${r.data.saved} ${r.data.saved === 1 ? 'detail' : 'details'} from ${fileName || 'your text'}.`,
    );
    setRows(null);
    setText('');
    setFileName('');
    onSaved();
  };

  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs?.map((r) => (r.key === key ? { ...r, ...patch } : r)) ?? null);
  const sections = rows ? [...new Set(rows.map((r) => r.section))] : [];
  const chosen = rows?.filter((r) => r.accept).length ?? 0;

  return (
    <Card className="space-y-2" data-testid="import-card">
      <h3 className="text-sm font-semibold">Import a résumé or profile</h3>
      {done && (
        <Banner tone="green" role="status">
          {done}
        </Banner>
      )}
      {error && (
        <Banner tone="red" role="alert">
          {error}
        </Banner>
      )}
      {!rows ? (
        <>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            PDF, Word or text. The file stays on this device. Contact details are found here and
            never sent; with AI help on, the rest of the text goes to Filler’s AI to pick out your
            details. You check everything before it is saved.
          </p>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-sm focus-within:outline-2 focus-within:outline-emerald-600 dark:border-slate-700">
            <FileUp aria-hidden className="h-4 w-4" />
            Choose a file
            <input
              type="file"
              accept=".pdf,.docx,.txt,.md,application/pdf,text/plain"
              className="sr-only"
              aria-label="Choose a résumé file"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </label>
          {fileName && <p className="text-xs">Read {fileName}.</p>}
          <TextArea
            label="Or paste text (a résumé, or your LinkedIn About and Experience)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
          <Button
            onClick={() => void analyze()}
            disabled={busy !== null || text.trim().length < 20}
          >
            Find my details
          </Button>
        </>
      ) : (
        <div className="space-y-2" data-testid="import-review">
          {note && <p className="text-xs text-slate-600 dark:text-slate-400">{note}</p>}
          {rows.length === 0 && <p className="text-sm">Filler found no details in that text.</p>}
          {sections.map((section) => (
            <fieldset key={section} className="space-y-1">
              <legend className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                {section}
              </legend>
              {rows
                .filter((r) => r.section === section)
                .map((r) => (
                  <div
                    key={r.key}
                    className="rounded border border-slate-200 p-1.5 dark:border-slate-800"
                    data-testid="import-row"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <label className="flex min-w-0 items-start gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={r.accept}
                          onChange={(e) => update(r.key, { accept: e.target.checked })}
                          className="mt-1"
                        />
                        <span className="break-words font-medium" data-testid="import-label">
                          {r.label}
                        </span>
                      </label>
                      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                    </div>
                    <input
                      aria-label={`Value for ${r.label}`}
                      value={r.draft}
                      onChange={(e) => update(r.key, { draft: e.target.value })}
                      className="mt-1 w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                    />
                    {r.existing !== undefined && r.status !== 'same' && (
                      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                        Saved now: {asText(r.existing)}
                      </p>
                    )}
                  </div>
                ))}
            </fieldset>
          ))}
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={busy !== null || chosen === 0}>
              Save {chosen} {chosen === 1 ? 'detail' : 'details'}
            </Button>
            <Button variant="ghost" onClick={() => setRows(null)}>
              Start over
            </Button>
          </div>
        </div>
      )}
      {busy && <Spinner label={busy} />}
    </Card>
  );
}
