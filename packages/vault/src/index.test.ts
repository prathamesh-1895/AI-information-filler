import { describe, expect, it } from 'vitest';
import { VAULT_DB_NAME } from './index';

describe('vault package', () => {
  it('exposes the vault database name', () => {
    expect(VAULT_DB_NAME).toBe('filler-vault');
  });
});
