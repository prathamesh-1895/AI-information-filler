/**
 * Screen Share & vision mode (PLAYBOOK Tasks 10.1–10.4). One picture, taken
 * only when the user asks; the user sees it and hides anything private
 * (never-fill fields are hidden automatically in a tab); then Filler's AI
 * reads the fields and Filler suggests values to copy. Filler never types
 * into a shared screen.
 */
import {
  siteOf,
  SOURCE_LABELS,
  type Box,
  type ScreenSuggestion,
  type VisionRequest,
} from '@filler/core';
import { Badge, Banner, Button, Card, Spinner } from '@filler/ui';
import { Camera, Copy, Eye, MonitorUp, Square, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { call } from '@/src/messaging/client';
import type { TabCapture } from '@/src/vision/capture';
import { bakeFrame, dragBox, grabFrame, HIDE_COLOUR, loadImage, toJpeg } from '@/src/vision/image';
import type { ScreenReading } from '@/src/vision/ops';
import { AiChip } from '../AiChip';
import { usePanel } from '../store';

interface Frame {
  id: string;
  src: string;
  width: number;
  height: number;
  /** Found automatically (never-fill fields), in image pixels. */
  auto: Box[];
  /** Drawn by the user, in image pixels. */
  user: Box[];
  mode: 'tab' | 'screen';
  title?: string;
  host?: string;
  tabId?: number;
  /** Image pixels per CSS pixel, and scroll, for tab frames. */
  page?: { scale: number; scrollX: number; scrollY: number };
  /**
   * The picture does not line up with the page's measured layout, so the
   * automatic boxes cannot be trusted: the user must hide things by hand
   * and confirm before anything is sent.
   */
  misaligned?: boolean;
  confirmed?: boolean;
}

/** Image and viewport disagree on shape by more than 3%: the boxes may be off. */
export function misaligned(
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): boolean {
  const sx = image.width / viewport.width;
  const sy = image.height / viewport.height;
  return Math.abs(sx - sy) / Math.max(sx, sy) > 0.03;
}

interface RegionAnswer {
  suggestion?: ScreenSuggestion;
  hint?: string;
  error?: string;
}

export function ScreenView() {
  const target = usePanel((s) => s.target);
  const sharing = usePanel((s) => s.sharing);
  const setSharing = usePanel((s) => s.setSharing);
  const aiStatus = usePanel((s) => s.aiStatus);
  const [segments, setSegments] = useState(1);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [readings, setReadings] = useState<Record<string, ScreenReading>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<'hide' | 'ask'>('hide');
  const [answer, setAnswer] = useState<RegionAnswer | null>(null);
  const aiOn = aiStatus?.mode === 'ai';

  const reset = (next: Frame[]) => {
    setFrames(next);
    setReadings({});
    setAnswer(null);
    setError(null);
  };

  const snapshot = async () => {
    if (!target) return;
    setBusy('Taking a picture of the tab…');
    setError(null);
    const r = await call<TabCapture>({ type: 'VISION_CAPTURE', tabId: target.tabId, segments });
    if (!r.ok) {
      setBusy(null);
      setError(r.error.message);
      return;
    }
    const next: Frame[] = [];
    for (const [i, seg] of r.data.segments.entries()) {
      const img = await loadImage(seg.dataUrl);
      const scale = img.naturalWidth / seg.viewport.width;
      const off = misaligned({ width: img.naturalWidth, height: img.naturalHeight }, seg.viewport);
      next.push({
        id: `tab-${Date.now()}-${i}`,
        src: seg.dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        auto: seg.hidden.map((b) => ({
          x: b.x * scale,
          y: b.y * scale,
          width: b.width * scale,
          height: b.height * scale,
        })),
        user: [],
        mode: 'tab',
        title: r.data.title,
        host: r.data.url.startsWith('http') ? siteOf(r.data.url) : '',
        tabId: r.data.tabId,
        page: { scale, scrollX: seg.scroll.x, scrollY: seg.scroll.y },
        ...(off && r.data.sensitiveFields > 0 ? { misaligned: true } : {}),
      });
    }
    setBusy(null);
    reset(next);
  };

  const startSharing = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      stream.getVideoTracks()[0]?.addEventListener('ended', () => setSharing(null));
      setSharing(stream);
    } catch {
      setError('Sharing was cancelled or is not allowed here.');
    }
  };

  const readShared = async () => {
    if (!sharing) return;
    setBusy('Taking a picture of what you share…');
    try {
      const shot = await grabFrame(sharing);
      reset([
        {
          id: `screen-${Date.now()}`,
          src: shot.dataUrl,
          width: shot.width,
          height: shot.height,
          auto: [],
          user: [],
          mode: 'screen',
        },
      ]);
    } catch (e) {
      setError(`Could not take a picture: ${String(e)}`);
    }
    setBusy(null);
  };

  const request = async (frame: Frame, crop?: Box): Promise<VisionRequest> => {
    const img = await loadImage(frame.src);
    const jpeg = toJpeg(bakeFrame(img, frame, [...frame.auto, ...frame.user], crop));
    return {
      image: { mimeType: 'image/jpeg', ...jpeg },
      mode: crop ? 'region' : frame.mode,
      ...(frame.title || frame.host
        ? {
            page: {
              ...(frame.host ? { host: frame.host } : {}),
              ...(frame.title ? { title: frame.title.slice(0, 200) } : {}),
            },
          }
        : {}),
    };
  };

  const read = async () => {
    setBusy('Filler’s AI is reading the picture…');
    setError(null);
    const out: Record<string, ScreenReading> = {};
    for (const frame of frames) {
      const req = await request(frame);
      const r = await call<ScreenReading>({
        type: 'VISION_READ',
        request: req,
        ...(frame.tabId !== undefined && frame.page
          ? {
              target: {
                tabId: frame.tabId,
                toPage: {
                  scale: frame.page.scale * (req.image.width / frame.width),
                  scrollX: frame.page.scrollX,
                  scrollY: frame.page.scrollY,
                },
              },
            }
          : {}),
      });
      if (!r.ok) {
        setError(r.error.message);
        break;
      }
      out[frame.id] = r.data;
    }
    setReadings(out);
    setBusy(null);
  };

  const askRegion = async (frame: Frame, box: Box) => {
    setAnswer(null);
    setBusy('Asking about that area…');
    const r = await call<ScreenReading>({
      type: 'VISION_READ',
      request: await request(frame, box),
    });
    setBusy(null);
    setAnswer(
      r.ok
        ? r.data.suggestions[0]
          ? {
              suggestion: r.data.suggestions[0],
              ...(r.data.fields[0]?.hint ? { hint: r.data.fields[0].hint } : {}),
            }
          : { error: 'Filler’s AI found no field in that area.' }
        : { error: r.error.message },
    );
  };

  const relabel = async (tabId: number, labels: Record<string, string>) => {
    const r = await call({ type: 'VISION_RELABEL', tabId, labels });
    setError(r.ok ? null : r.error.message);
    if (r.ok) usePanel.getState().setView('fill');
  };

  const blocked = frames.some((f) => f.misaligned && !f.confirmed);
  const readingsList = frames.flatMap((f) =>
    readings[f.id] ? [{ frame: f, reading: readings[f.id]! }] : [],
  );
  const relabels = readingsList.flatMap(({ frame, reading }) =>
    reading.relabel.length && frame.tabId !== undefined
      ? [{ tabId: frame.tabId, items: reading.relabel }]
      : [],
  );

  return (
    <div className="space-y-3" data-testid="screen-view">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold">Read the screen</h2>
        <AiChip />
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        For forms Filler can’t read directly (drawn on a canvas, inside other apps). Filler takes
        one picture when you ask, you hide anything private, then its AI reads the fields.
      </p>

      <Card className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="segments" className="block text-xs font-medium">
              How much of the tab
            </label>
            <select
              id="segments"
              value={segments}
              onChange={(e) => setSegments(Number(e.target.value))}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
            >
              <option value={1}>What I can see</option>
              <option value={3}>Up to 3 screens down</option>
            </select>
          </div>
          <Button size="sm" onClick={() => void snapshot()} disabled={!target || busy !== null}>
            <Camera aria-hidden className="h-4 w-4" />
            Snapshot this tab
          </Button>
        </div>
        {sharing ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void readShared()} disabled={busy !== null}>
              <Eye aria-hidden className="h-4 w-4" />
              Take a picture of the shared screen
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void startSharing()}
            disabled={busy !== null}
          >
            <MonitorUp aria-hidden className="h-4 w-4" />
            Share a screen or window
          </Button>
        )}
      </Card>

      {busy && <Spinner label={busy} />}
      {error && (
        <Banner tone="red" role="alert">
          {error}
        </Banner>
      )}

      {frames.length > 0 && (
        <section aria-labelledby="preview-title" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="preview-title" className="text-sm font-semibold">
              Check the picture before it is sent
            </h3>
            <div role="group" aria-label="Drawing tool" className="flex gap-1">
              <Button
                size="sm"
                variant={tool === 'hide' ? 'primary' : 'ghost'}
                aria-pressed={tool === 'hide'}
                onClick={() => setTool('hide')}
              >
                <Square aria-hidden className="h-3.5 w-3.5" />
                Hide an area
              </Button>
              <Button
                size="sm"
                variant={tool === 'ask' ? 'primary' : 'ghost'}
                aria-pressed={tool === 'ask'}
                onClick={() => setTool('ask')}
                disabled={!aiOn}
              >
                What is this?
              </Button>
            </div>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {tool === 'hide'
              ? 'Drag over anything private to hide it. Hidden areas are blacked out on your device; the AI never sees them.'
              : 'Drag around one field to ask what it wants.'}
          </p>
          {frames.map((frame) => (
            <div key={frame.id} className="space-y-1">
              {frame.misaligned && (
                <Banner tone="red" data-testid="misaligned">
                  <p>
                    Filler could not line up this picture with the page, so it may have missed
                    password, card or ID fields. Hide them yourself by dragging over them.
                  </p>
                  <label className="mt-1 flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={frame.confirmed ?? false}
                      onChange={(e) =>
                        setFrames((fs) =>
                          fs.map((f) =>
                            f.id === frame.id ? { ...f, confirmed: e.target.checked } : f,
                          ),
                        )
                      }
                    />
                    I have hidden everything private on this picture
                  </label>
                </Banner>
              )}
              <FramePreview
                frame={frame}
                onBox={(box) =>
                  tool === 'hide'
                    ? setFrames((fs) =>
                        fs.map((f) => (f.id === frame.id ? { ...f, user: [...f.user, box] } : f)),
                      )
                    : void askRegion(frame, box)
                }
                onUndo={() =>
                  setFrames((fs) =>
                    fs.map((f) => (f.id === frame.id ? { ...f, user: f.user.slice(0, -1) } : f)),
                  )
                }
              />
            </div>
          ))}
          {answer && <RegionAnswerCard answer={answer} />}
          <Button
            className="w-full"
            onClick={() => void read()}
            disabled={!aiOn || busy !== null || blocked}
          >
            Read with AI
          </Button>
          {!aiOn && (
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Reading the picture needs AI ({aiStatus?.reason ?? 'offline'}). Nothing has been sent.
            </p>
          )}
        </section>
      )}

      {readingsList.length > 0 && (
        <section aria-labelledby="results-title" className="space-y-2" data-testid="screen-results">
          <h3 id="results-title" className="text-sm font-semibold">
            {readingsList[0]!.reading.formPurpose}
          </h3>
          {readingsList
            .flatMap(({ reading }) => reading.warnings)
            .map((w) => (
              <Banner key={w} tone="amber">
                {w}
              </Banner>
            ))}
          {relabels.map(({ tabId, items }) => (
            <Banner
              key={tabId}
              tone="blue"
              data-testid="relabel"
              action={
                <Button
                  size="sm"
                  onClick={() =>
                    void relabel(tabId, Object.fromEntries(items.map((i) => [i.domId, i.label])))
                  }
                >
                  Use these labels
                </Button>
              }
            >
              Filler can fill {items.length} more {items.length === 1 ? 'field' : 'fields'} on this
              page with the labels it read ({items.map((i) => `“${i.label}”`).join(', ')}).
            </Banner>
          ))}
          {relabels.length === 0 && (
            <p className="text-sm" data-testid="copy-note">
              Filler can’t type into this app. Copy each value.
            </p>
          )}
          <ul className="space-y-1.5">
            {readingsList.flatMap(({ frame, reading }) =>
              reading.suggestions.map((s) => (
                <SuggestionRow key={`${frame.id}-${s.fieldId}`} s={s} />
              )),
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

function FramePreview({
  frame,
  onBox,
  onUndo,
}: {
  frame: Frame;
  onBox: (box: Box) => void;
  onUndo: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{
    a: { x: number; y: number };
    b: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void loadImage(frame.src).then((img) => {
      const canvas = ref.current;
      if (!alive || !canvas) return;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = HIDE_COLOUR;
      for (const b of [...frame.auto, ...frame.user]) ctx.fillRect(b.x, b.y, b.width, b.height);
      if (drag) {
        const box = dragBox(drag.a, drag.b, frame);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = Math.max(2, frame.width / 300);
        ctx.strokeRect(box.x, box.y, box.width, box.height);
      }
    });
    return () => {
      alive = false;
    };
  }, [frame, drag]);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * frame.width,
      y: ((e.clientY - r.top) / r.height) * frame.height,
    };
  };

  return (
    <figure className="space-y-1" data-testid="frame">
      <canvas
        ref={ref}
        width={frame.width}
        height={frame.height}
        data-testid="frame-canvas"
        className="w-full cursor-crosshair touch-none rounded border border-slate-300 dark:border-slate-700"
        aria-label="Picture to send. Drag to mark an area."
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          setDrag({ a: p, b: p });
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, b: point(e) })}
        onPointerUp={(e) => {
          if (!drag) return;
          const box = dragBox(drag.a, point(e), frame);
          setDrag(null);
          if (box.width > 4 && box.height > 4) onBox(box);
        }}
      />
      <figcaption className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
        <span data-testid="hidden-count">
          {frame.auto.length + frame.user.length} hidden
          {frame.auto.length
            ? ` (${frame.auto.length} never-fill ${frame.auto.length === 1 ? 'field' : 'fields'} hidden automatically)`
            : ''}
        </span>
        {frame.user.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onUndo}>
            <Undo2 aria-hidden className="h-3.5 w-3.5" />
            Undo
          </Button>
        )}
      </figcaption>
    </figure>
  );
}

function SuggestionRow({ s }: { s: ScreenSuggestion }) {
  const [copied, setCopied] = useState(false);
  return (
    <li
      className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-800"
      data-testid="suggestion"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium break-words" data-testid="suggestion-label">
          {s.label}
        </span>
        {s.status === 'denied' && <Badge tone="red">Never filled</Badge>}
        {s.status === 'value' && (
          <Badge tone={s.source === 'ai' ? 'amber' : 'green'}>{s.keyLabel}</Badge>
        )}
      </div>
      {s.status === 'value' ? (
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="min-w-0 break-words" data-testid="suggestion-value">
            {s.value}
          </span>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Copy ${s.label}`}
            onClick={() =>
              void navigator.clipboard.writeText(s.value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            <Copy aria-hidden className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      ) : (
        <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{s.reason}</p>
      )}
    </li>
  );
}

function RegionAnswerCard({ answer }: { answer: RegionAnswer }) {
  if (answer.error)
    return (
      <Banner tone="amber" role="status">
        {answer.error}
      </Banner>
    );
  const s = answer.suggestion!;
  return (
    <Card className="space-y-1" data-testid="region-answer">
      <p className="text-sm font-medium">{s.label}</p>
      {answer.hint && <p className="text-sm">{answer.hint}</p>}
      {s.status === 'value' ? (
        <p className="text-sm">
          Filler would use: <span className="font-medium">{s.value}</span>
        </p>
      ) : (
        <p className="text-sm">{s.reason}</p>
      )}
      <p className="text-xs text-slate-600 dark:text-slate-400">Source: {SOURCE_LABELS.vision}</p>
    </Card>
  );
}

/** Persistent indicator while a screen or window is shared (shown in the header). */
export function SharingIndicator() {
  const sharing = usePanel((s) => s.sharing);
  const setSharing = usePanel((s) => s.setSharing);
  if (!sharing) return null;
  return (
    <div className="flex items-center gap-1.5" role="status" data-testid="sharing">
      <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-900 dark:bg-red-900/50 dark:text-red-100">
        <span aria-hidden className="h-2 w-2 rounded-full bg-red-600" />
        Sharing
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          for (const t of sharing.getTracks()) t.stop();
          setSharing(null);
        }}
      >
        Stop sharing
      </Button>
    </div>
  );
}
