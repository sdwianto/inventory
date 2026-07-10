/** Error jaringan/timeout — server mungkin sudah commit (jangan rollback optimistik). */

export class PoMutationAmbiguousError extends Error {
  poId?: string;

  constructor(message = 'Permintaan mungkin sudah diproses — memuat ulang status PO…', poId?: string) {
    super(message);
    this.name = 'PoMutationAmbiguousError';
    this.poId = poId;
  }
}

export function isAmbiguousHttpStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export function isAmbiguousNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && /network|fetch|timeout|aborted/i.test(err.message)) return true;
  return false;
}
