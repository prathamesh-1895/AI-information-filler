import { describe, expect, it } from 'vitest';
import { AI_ENDPOINTS } from './index';

describe('ai-client endpoints', () => {
  it('names are unique', () => {
    const names = Object.values(AI_ENDPOINTS);
    expect(new Set(names).size).toBe(names.length);
  });
});
