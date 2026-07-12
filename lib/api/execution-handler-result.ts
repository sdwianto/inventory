/** Normalize legacy handler outcomes for execution platform (throw → fail/retry). */

export function assertExecutionHandlerSuccess(
  result: Record<string, unknown> | void,
): Record<string, unknown> | void {
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    throw new Error(String(result.error));
  }
  return result;
}
