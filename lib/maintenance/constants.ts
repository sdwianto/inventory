import type { AssetStatus, MaintenancePriority, MaintenanceRequestStatus } from '@/types/maintenance';

export const ASSETS_COLLECTION = 'assets';
export const MAINTENANCE_REQUESTS_COLLECTION = 'maintenance_requests';
export const MAINTENANCE_SCHEDULES_COLLECTION = 'maintenance_schedules';

export const PM_MANAGE_ROLES = ['SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;
export const PM_VIEW_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;
export const PM_REPORT_ROLES = ['SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;

export const ASSET_MANAGE_ROLES = ['SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;
export const ASSET_VIEW_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;

export const WR_CREATE_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;
export const WR_SUBMIT_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;
export const WR_APPROVE_ROLES = ['ADMIN', 'OWNER', 'MASTER'] as const;
export const WR_PROGRESS_ROLES = ['SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'] as const;

export const RESOLUTION_TYPE_LABELS: Record<string, string> = {
  PO: 'PO Vendor (sales.app)',
  INTERNAL: 'Release Stok',
  SERVICE: 'Jasa Perbaikan',
};

export const ASSET_KATEGORI = [
  'Mesin Dapur',
  'Kendaraan',
  'IT & Elektronik',
  'Pendingin & AC',
  'Bangunan & Instalasi',
  'Peralatan Kantor',
  'Lainnya',
] as const;

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  ACTIVE: 'Aktif',
  IN_REPAIR: 'Dalam Perbaikan',
  RETIRED: 'Tidak Dipakai',
  DISPOSED: 'Dibuang',
};

export const ASSET_STATUS_STYLE: Record<AssetStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  IN_REPAIR: 'bg-amber-100 text-amber-800',
  RETIRED: 'bg-slate-100 text-slate-600',
  DISPOSED: 'bg-red-100 text-red-700',
};

export const WR_PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  LOW: 'Rendah',
  MEDIUM: 'Sedang',
  HIGH: 'Tinggi',
  CRITICAL: 'Kritis',
};

export const WR_PRIORITY_STYLE: Record<MaintenancePriority, string> = {
  LOW: 'bg-slate-100 text-slate-700',
  MEDIUM: 'bg-blue-100 text-blue-800',
  HIGH: 'bg-orange-100 text-orange-800',
  CRITICAL: 'bg-red-100 text-red-800',
};

export const WR_STATUS_LABELS: Record<MaintenanceRequestStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Menunggu Approval',
  APPROVED: 'Disetujui',
  IN_PROGRESS: 'Dikerjakan',
  COMPLETED: 'Selesai',
  CLOSED: 'Ditutup',
  REJECTED: 'Ditolak',
  CANCELLED: 'Dibatalkan',
};

export const WR_STATUS_STYLE: Record<MaintenanceRequestStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  IN_PROGRESS: 'bg-indigo-100 text-indigo-800',
  COMPLETED: 'bg-green-100 text-green-800',
  CLOSED: 'bg-slate-100 text-slate-600',
  REJECTED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

export const OPEN_WR_STATUSES: MaintenanceRequestStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
];

/** WR yang mencegah penghapusan aset. */
export const BLOCKING_WR_STATUSES: MaintenanceRequestStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
];

export const EMPTY_ASSET = {
  kode: '',
  nama: '',
  kategori: 'Lainnya',
  lokasi: '',
  serialNumber: '',
  merk: '',
  model: '',
  status: 'ACTIVE' as AssetStatus,
  tanggalBeli: '',
  nilaiPerolehan: 0,
  vendorAsal: '',
  catatan: '',
  fotoBase64: '',
};

export const EMPTY_WR = {
  assetId: '',
  priority: 'MEDIUM' as MaintenancePriority,
  judul: '',
  deskripsi: '',
  photos: [] as string[],
};

export const PM_INTERVAL_LABELS: Record<string, string> = {
  DAYS: 'Hari',
  WEEKS: 'Minggu',
  MONTHS: 'Bulan',
};

export const PM_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Aktif',
  PAUSED: 'Dijeda',
  ARCHIVED: 'Arsip',
};

export const PM_STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  PAUSED: 'bg-amber-100 text-amber-800',
  ARCHIVED: 'bg-slate-100 text-slate-500',
};

export const WR_SOURCE_LABELS: Record<string, string> = {
  CORRECTIVE: 'Korektif',
  PREVENTIVE: 'Preventif (PM)',
};

export const EMPTY_PM_SCHEDULE = {
  assetId: '',
  judul: '',
  deskripsi: '',
  checklist: '',
  priority: 'MEDIUM' as MaintenancePriority,
  intervalUnit: 'MONTHS' as const,
  intervalValue: 1,
  leadDays: 7,
  nextDueDate: '',
  status: 'ACTIVE' as const,
};
