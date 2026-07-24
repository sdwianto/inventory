import { describe, expect, it } from 'vitest';
import { assertExecutionHandlerSuccess } from '@/lib/api/execution-handler-result';
import { AuthError, ValidationError } from '@/lib/execution/contracts/errors';

describe('assertExecutionHandlerSuccess', () => {
  it('passes through success results', () => {
    expect(assertExecutionHandlerSuccess({ ok: true })).toEqual({ ok: true });
    expect(assertExecutionHandlerSuccess(undefined)).toBeUndefined();
  });

  it('throws AuthError for unauthorized / 401', () => {
    expect(() => assertExecutionHandlerSuccess({ error: 'Unauthorized' })).toThrow(AuthError);
    expect(() => assertExecutionHandlerSuccess({ error: 'Sales.app HTTP 401' })).toThrow(AuthError);
  });

  it('throws ValidationError for not-paired / wajib', () => {
    expect(() => assertExecutionHandlerSuccess({ error: 'Belum di-pair dengan sales.app' }))
      .toThrow(ValidationError);
  });

  it('throws plain Error for other failures', () => {
    expect(() => assertExecutionHandlerSuccess({ error: 'timeout connecting' })).toThrow(Error);
    try {
      assertExecutionHandlerSuccess({ error: 'timeout connecting' });
      expect.unreachable('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(AuthError);
      expect(e).not.toBeInstanceOf(ValidationError);
    }
  });
});
