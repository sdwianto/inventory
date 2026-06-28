import { describe, expect, it } from 'vitest';
import { txOpts } from '@/lib/api/transaction';

describe('transaction', () => {
  it('txOpts returns empty object without session', () => {
    expect(txOpts()).toEqual({});
  });

  it('txOpts includes session when provided', () => {
    const session = { id: 'test-session' } as never;
    expect(txOpts(session)).toEqual({ session });
  });
});
