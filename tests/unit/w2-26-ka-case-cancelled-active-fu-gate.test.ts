import { describe, expect, it } from 'vitest';
import { assertKaCaseTerminalBlockedByActiveFollowUps } from '@/lib/kitchen-assurance/safety-case';

describe('W2-26 KA case terminal blocked by active follow-ups', () => {
  it('CLOSED + count>0 → message contains tutup', () => {
    const msg = assertKaCaseTerminalBlockedByActiveFollowUps('CLOSED', 2);
    expect(msg).toBeTruthy();
    expect(msg).toContain('tutup');
    expect(msg).toContain('2');
  });

  it('CANCELLED + count>0 → message contains batalkan', () => {
    const msg = assertKaCaseTerminalBlockedByActiveFollowUps('CANCELLED', 1);
    expect(msg).toBeTruthy();
    expect(msg).toContain('batalkan');
    expect(msg).toContain('1');
  });

  it('count=0 → null for CLOSED and CANCELLED', () => {
    expect(assertKaCaseTerminalBlockedByActiveFollowUps('CLOSED', 0)).toBeNull();
    expect(assertKaCaseTerminalBlockedByActiveFollowUps('CANCELLED', 0)).toBeNull();
  });

  it('OPEN/IN_PROGRESS + count>0 → null (gate only for terminal)', () => {
    expect(assertKaCaseTerminalBlockedByActiveFollowUps('OPEN', 3)).toBeNull();
    expect(assertKaCaseTerminalBlockedByActiveFollowUps('IN_PROGRESS', 3)).toBeNull();
    expect(assertKaCaseTerminalBlockedByActiveFollowUps('PENDING_VERIFY', 3)).toBeNull();
  });
});
