/** Shared Food Production role sets — ADR-001. */

/** Write ops (Issue/Result/Plan/XFR) + management analytics reads. */
export const FP_MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

/**
 * Cost / Nutrition analyze / Forecast / AI Recommendations / Dashboard / Price book.
 * GUDANG (operator) excluded per ADR coding standard #5.
 * QC/HACCP/cold-chain *recording* is ops — see FP_OPS_WRITE_ROLES.
 */
export const FP_MGMT_READ_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

/**
 * Dapur-facing write: cold-chain log, HACCP checklist, QC create/edit/submit (ADR #5 dapur mencatat).
 * Threshold / template master / APPROVE·COMPLETE·CANCEL tetap FP_MANAGE_ROLES.
 */
export const FP_OPS_WRITE_ROLES = ['GUDANG', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

/**
 * Driver: lihat Titik Layanan + update status Distribusi (dikirim/selesai).
 * Create/edit/delete DO & master Titik Layanan tetap FP_MANAGE_ROLES.
 */
export const FP_DIST_STATUS_ROLES = ['DRIVER', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
