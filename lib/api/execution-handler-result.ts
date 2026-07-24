/** Normalize legacy handler outcomes for execution platform (throw → fail/retry). */

import { AuthError, ValidationError } from '@/lib/execution/contracts/errors';

function isAuthMessage(msg: string): boolean {
  return /\b(401|403)\b/.test(msg) || /unauthorized/i.test(msg);
}

function isValidationMessage(msg: string): boolean {
  return /belum di-pair/i.test(msg) || /wajib/i.test(msg) || /tidak lengkap/i.test(msg);
}

export function assertExecutionHandlerSuccess(
  result: Record<string, unknown> | void,
): Record<string, unknown> | void {
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    const msg = String(result.error);
    if (isAuthMessage(msg)) throw new AuthError(msg);
    if (isValidationMessage(msg)) throw new ValidationError(msg);
    throw new Error(msg);
  }
  return result;
}
