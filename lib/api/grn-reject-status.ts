/**
 * Baris GRN dengan qtyRejected > 0 dianggap PENDING (belum ditindaklanjuti) bila rejectStatus
 * eksplisit 'PENDING' ATAU field-nya belum ada sama sekali — GRN yang diposting sebelum
 * rejectStatus diperkenalkan tidak punya field ini, tapi tetap butuh tindak lanjut yang sama.
 */

/** Kondisi Mongo untuk "rejectStatus PENDING atau belum ada" — dipakai di dalam $elemMatch. */
export function rejectStatusPendingOr(): Array<Record<string, unknown>> {
  return [{ rejectStatus: 'PENDING' }, { rejectStatus: { $exists: false } }];
}

/** $elemMatch untuk satu baris item GRN yang masih PENDING tindak lanjut. */
export function grnPendingRejectElemMatch(): Record<string, unknown> {
  return {
    qtyRejected: { $gt: 0 },
    $or: rejectStatusPendingOr(),
  };
}

/** Filter dokumen GRN yang punya minimal satu baris PENDING tindak lanjut. */
export function grnPendingRejectFilter(): Record<string, unknown> {
  return { items: { $elemMatch: grnPendingRejectElemMatch() } };
}
