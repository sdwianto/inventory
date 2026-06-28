import type { JsonObject } from '@/types/json';

export type AssetStatus = 'ACTIVE' | 'IN_REPAIR' | 'RETIRED' | 'DISPOSED';

export type MaintenancePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type MaintenanceRequestStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED';

export type MaintenanceResolutionType = 'PO' | 'SERVICE' | 'INTERNAL' | null;

export type MaintenanceRequestSource = 'CORRECTIVE' | 'PREVENTIVE';

export type MaintenanceScheduleStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export type MaintenanceIntervalUnit = 'DAYS' | 'WEEKS' | 'MONTHS';

export type AssetDoc = JsonObject & {
  id?: string;
  tenantId?: string;
  kode?: string;
  nama?: string;
  kategori?: string;
  lokasi?: string;
  serialNumber?: string;
  merk?: string;
  model?: string;
  status?: AssetStatus;
  tanggalBeli?: string | Date | null;
  nilaiPerolehan?: number;
  vendorAsal?: string;
  catatan?: string;
  fotoBase64?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  createdBy?: JsonObject;
};

export type MaintenanceRequestDoc = JsonObject & {
  id?: string;
  tenantId?: string;
  noWR?: string;
  assetId?: string;
  assetKode?: string;
  assetNama?: string;
  priority?: MaintenancePriority;
  judul?: string;
  deskripsi?: string;
  photos?: string[];
  status?: MaintenanceRequestStatus;
  catatanPenyelesaian?: string;
  createdBy?: JsonObject;
  requestedBy?: JsonObject;
  approvedBy?: JsonObject;
  rejectedBy?: JsonObject;
  rejectReason?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  requestedAt?: Date | string | null;
  approvedAt?: Date | string | null;
  rejectedAt?: Date | string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  closedAt?: Date | string | null;
  resolutionType?: MaintenanceResolutionType;
  linkedPoId?: string | null;
  linkedPoNo?: string | null;
  linkedReleaseId?: string | null;
  linkedReleaseNo?: string | null;
  linkedServiceOrderId?: string | null;
  linkedServiceOrderNo?: string | null;
  linkedGrnId?: string | null;
  linkedGrnNo?: string | null;
  autoClosedAt?: Date | string | null;
  autoClosedBy?: string | null;
  sourceType?: MaintenanceRequestSource;
  scheduleId?: string | null;
  noSchedule?: string | null;
};

export type MaintenanceScheduleDoc = JsonObject & {
  id?: string;
  tenantId?: string;
  noPM?: string;
  assetId?: string;
  assetKode?: string;
  assetNama?: string;
  judul?: string;
  deskripsi?: string;
  checklist?: string;
  priority?: MaintenancePriority;
  intervalUnit?: MaintenanceIntervalUnit;
  intervalValue?: number;
  leadDays?: number;
  nextDueDate?: Date | string;
  lastCompletedAt?: Date | string | null;
  lastGeneratedAt?: Date | string | null;
  lastWrId?: string | null;
  lastWrNo?: string | null;
  status?: MaintenanceScheduleStatus;
  createdBy?: JsonObject;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type MaintenanceServiceOrderStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';

export type MaintenanceServiceOrderDoc = JsonObject & {
  id?: string;
  tenantId?: string;
  noMSO?: string;
  maintenanceRequestId?: string;
  noWR?: string;
  assetId?: string;
  assetKode?: string;
  assetNama?: string;
  vendorName?: string;
  vendorContact?: string;
  scope?: string;
  estimasiBiaya?: number;
  actualBiaya?: number | null;
  status?: MaintenanceServiceOrderStatus;
  hutangId?: string | null;
  completedNote?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  completedAt?: Date | string | null;
  createdBy?: JsonObject;
};
