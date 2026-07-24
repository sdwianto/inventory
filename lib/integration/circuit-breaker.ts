/** Circuit breaker minimal: CLOSED → OPEN → HALF_OPEN → CLOSED */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitBreakerOptions = {
  failureThreshold?: number;
  openMs?: number;
  halfOpenMax?: number;
};

type Breaker = {
  state: CircuitState;
  failures: number;
  openedAt: number;
  halfOpenInFlight: number;
  opts: Required<CircuitBreakerOptions>;
};

const DEFAULTS: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  openMs: 30_000,
  halfOpenMax: 1,
};

const breakers = new Map<string, Breaker>();

function getBreaker(name: string, opts?: CircuitBreakerOptions): Breaker {
  let b = breakers.get(name);
  if (!b) {
    b = {
      state: 'CLOSED',
      failures: 0,
      openedAt: 0,
      halfOpenInFlight: 0,
      opts: { ...DEFAULTS, ...opts },
    };
    breakers.set(name, b);
  }
  return b;
}

/** Test-only reset. */
export function resetCircuitBreakers(): void {
  breakers.clear();
}

export function getCircuitState(name: string): CircuitState {
  return getBreaker(name).state;
}

export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: CircuitBreakerOptions,
): Promise<T> {
  const b = getBreaker(name, opts);
  const now = Date.now();

  if (b.state === 'OPEN') {
    if (now - b.openedAt < b.opts.openMs) {
      const err = new Error(`Circuit breaker OPEN (${name})`);
      (err as Error & { code: string }).code = 'CIRCUIT_OPEN';
      throw err;
    }
    b.state = 'HALF_OPEN';
    b.halfOpenInFlight = 0;
  }

  if (b.state === 'HALF_OPEN') {
    if (b.halfOpenInFlight >= b.opts.halfOpenMax) {
      const err = new Error(`Circuit breaker HALF_OPEN saturated (${name})`);
      (err as Error & { code: string }).code = 'CIRCUIT_OPEN';
      throw err;
    }
    b.halfOpenInFlight += 1;
  }

  try {
    const result = await fn();
    b.failures = 0;
    b.state = 'CLOSED';
    b.halfOpenInFlight = 0;
    return result;
  } catch (e) {
    if (b.state === 'HALF_OPEN') {
      b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
      b.state = 'OPEN';
      b.openedAt = Date.now();
      throw e;
    }
    b.failures += 1;
    if (b.failures >= b.opts.failureThreshold) {
      b.state = 'OPEN';
      b.openedAt = Date.now();
    }
    throw e;
  }
}
