/**
 * Rekonsiliasi harian (Fase 6): satu laporan per tenant per job di `recon_reports`.
 * Detektor hanya membaca; perbaikan tetap lewat dokumen koreksi di worklist masing-masing.
 */

export const RECON_JOBS = ['stock', 'po-receipt', 'grni', 'plan-issue'] as const;
export type ReconJob = typeof RECON_JOBS[number];

export const RECON_KINDS = {
  stock: [
    'STOCK_HOME_VS_LEDGER',
    'STOCK_MASTER_VS_LOKASI',
    'STOCK_PHANTOM_WAREHOUSE',
    'STOCK_LEDGER_NEGATIVE',
    'STOCK_LOT_GT_LOKASI',
    'STOCK_BIN_GT_LOKASI',
    'STOCK_FLOAT_DUST',
    'STOCK_ZERO_COST_OUT',
  ],
  'po-receipt': [
    'PO_QTY_RECEIVED_MISMATCH',
    'PO_GRN_NOT_APPLIED',
    'PO_GRN_REVERSAL_NOT_APPLIED',
  ],
  grni: [
    'GRNI_BILL_RESIDUAL',
    'GRNI_UNBILLED_AGED',
    'GL_INVENTORY_VS_VALUATION',
  ],
  'plan-issue': [
    'RL_UNLINKED',
    'RL_OVER_REFERENCE_UNAPPROVED',
    'PBL_MUTATING_WITH_RL',
  ],
} as const satisfies Record<ReconJob, readonly string[]>;

export type ReconKind = typeof RECON_KINDS[ReconJob][number];

export const ALL_RECON_KINDS: ReconKind[] = RECON_JOBS.flatMap((j) => [...RECON_KINDS[j]]);

export type ReconRefType =
  | 'PRODUCT'
  | 'PO'
  | 'GRN'
  | 'HUTANG'
  | 'RELEASE'
  | 'MATERIAL_ISSUE'
  | 'PLAN'
  | 'JOURNAL'
  | 'TENANT';

export interface ReconFinding {
  kind: ReconKind;
  refType: ReconRefType;
  refId?: string;
  refNo?: string;
  productId?: string;
  kode?: string;
  nama?: string;
  lokasiKode?: string;
  expected?: number;
  actual?: number;
  delta?: number;
  detail: string;
}

export type ReconReportStatus = 'OK' | 'SKIPPED' | 'ERROR';

export interface ReconReport {
  id: string;
  tenantId: string;
  job: ReconJob;
  status: ReconReportStatus;
  createdAt: Date;
  durationMs: number;
  summary: Partial<Record<ReconKind, number>>;
  totalMismatch: number;
  findings: ReconFinding[];
  /** `findings` dipotong di RECON_FINDINGS_CAP; `summary` tetap hitungan penuh. */
  truncated: boolean;
  skippedReason?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export const RECON_FINDINGS_CAP = 200;

/** Hasil detektor sebelum disimpan. */
export interface ReconDetectResult {
  findings: ReconFinding[];
  /** Hitungan per kind bila lebih besar dari jumlah temuan yang dikumpulkan. */
  counts?: Partial<Record<ReconKind, number>>;
  skippedReason?: string;
  meta?: Record<string, unknown>;
}
