/**
 * Frame preparation in the panel (PLAYBOOK Task 10.1): hidden areas are
 * painted over in the pixels themselves (solid fill, not a reversible blur)
 * and the frame is downscaled to a JPEG before anything is uploaded.
 */
import { VISION_MAX_EDGE, type Box } from '@filler/core';

export const HIDE_COLOUR = '#0f172a';

/** Scale factor (≤ 1) so the longest edge fits `max`. */
export function fitScale(width: number, height: number, max = VISION_MAX_EDGE): number {
  const longest = Math.max(width, height);
  return longest > max ? max / longest : 1;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be loaded.'));
    img.src = src;
  });
}

/** Draws `source` (cropped to `crop` if given) with every hidden box painted over. */
export function bakeFrame(
  source: CanvasImageSource,
  size: { width: number; height: number },
  hidden: readonly Box[],
  crop?: Box,
): HTMLCanvasElement {
  const area = crop ?? { x: 0, y: 0, ...size };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.width));
  canvas.height = Math.max(1, Math.round(area.height));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  ctx.fillStyle = HIDE_COLOUR;
  for (const b of hidden) ctx.fillRect(b.x - area.x, b.y - area.y, b.width, b.height);
  return canvas;
}

/** Downscales a canvas to a JPEG for upload. */
export function toJpeg(canvas: HTMLCanvasElement): { data: string; width: number; height: number } {
  const scale = fitScale(canvas.width, canvas.height);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  const url = out.toDataURL('image/jpeg', 0.82);
  return { data: url.slice(url.indexOf(',') + 1), width: out.width, height: out.height };
}

/** One frame from a shared screen or window (getDisplayMedia stream). */
export async function grabFrame(
  stream: MediaStream,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth)
    await new Promise((r) => video.addEventListener('resize', r, { once: true }));
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0);
  video.pause();
  video.srcObject = null;
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

/** Normalises a dragged rectangle (any direction) and clamps it to the frame. */
export function dragBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: { width: number; height: number },
): Box {
  const x = Math.max(0, Math.min(a.x, b.x));
  const y = Math.max(0, Math.min(a.y, b.y));
  return {
    x,
    y,
    width: Math.min(size.width, Math.max(a.x, b.x)) - x,
    height: Math.min(size.height, Math.max(a.y, b.y)) - y,
  };
}
