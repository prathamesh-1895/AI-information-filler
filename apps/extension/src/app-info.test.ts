import { describe, expect, it } from 'vitest';
import { APP_NAME } from './app-info';

describe('app info', () => {
  it('has the product name', () => {
    expect(APP_NAME).toBe('Filler');
  });
});
