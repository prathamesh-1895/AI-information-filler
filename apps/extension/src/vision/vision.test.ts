import { describe, expect, it } from 'vitest';
import { toViewport } from './capture';
import { dragBox, fitScale } from './image';

describe('capture geometry', () => {
  it('turns document boxes into padded, clipped viewport boxes', () => {
    const viewport = { width: 800, height: 600 };
    expect(
      toViewport([{ x: 100, y: 1250, width: 200, height: 30 }], { x: 0, y: 1000 }, viewport),
    ).toEqual([{ x: 94, y: 244, width: 212, height: 42 }]);
    // Off-screen boxes disappear; boxes at the edge are clipped.
    expect(
      toViewport([{ x: 0, y: 50, width: 10, height: 10 }], { x: 0, y: 1000 }, viewport),
    ).toEqual([]);
    expect(
      toViewport([{ x: 790, y: 590, width: 50, height: 50 }], { x: 0, y: 0 }, viewport),
    ).toEqual([{ x: 784, y: 584, width: 16, height: 16 }]);
  });

  it('downscales to at most 1600 px on the long edge', () => {
    expect(fitScale(1280, 720)).toBe(1);
    expect(fitScale(3200, 1800)).toBe(0.5);
    expect(fitScale(900, 4000)).toBe(0.4);
  });

  it('normalises dragged rectangles in any direction and clamps them', () => {
    expect(dragBox({ x: 300, y: 200 }, { x: 100, y: -20 }, { width: 250, height: 500 })).toEqual({
      x: 100,
      y: 0,
      width: 150,
      height: 200,
    });
  });
});
