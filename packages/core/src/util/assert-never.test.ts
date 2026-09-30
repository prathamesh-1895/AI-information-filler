import { describe, expect, it } from 'vitest';
import { assertNever } from './assert-never';

describe('assertNever', () => {
  it('throws with the offending value', () => {
    expect(() => assertNever('x' as never)).toThrow('Unexpected value: "x"');
  });
});
