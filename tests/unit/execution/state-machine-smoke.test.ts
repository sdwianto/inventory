import { describe, it, expect } from 'vitest';
import { isTransitionAllowed } from '@/lib/execution/contracts/transitions';

describe('execution state machine (inventory smoke)', () => {
  it('PENDING may transition to RUNNING', () => {
    expect(isTransitionAllowed('PENDING', 'RUNNING')).toBe(true);
  });

  it('SUCCEEDED has no outgoing transitions', () => {
    expect(isTransitionAllowed('SUCCEEDED', 'PENDING')).toBe(false);
    expect(isTransitionAllowed('SUCCEEDED', 'RUNNING')).toBe(false);
  });
});
