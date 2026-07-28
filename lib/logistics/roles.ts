/**
 * Logistics role sets — Sprint 5.4 (docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md).
 * Moved from lib/food-production/roles.ts FP_DIST_STATUS_ROLES — this governs who can
 * execute the physical delivery act (status Dikirim/Selesai on a Dispatch document),
 * a Logistics operational concern even though the document itself belongs to Dispatch.
 *
 * Driver: lihat Titik Layanan (Destination Master, shared — lihat Sprint 5.3 Decision
 * Record) + update status pengiriman (dikirim/selesai) pada dokumen Dispatch.
 * Create/edit/delete Dispatch & master Titik Layanan tetap FP_MANAGE_ROLES.
 */
export const LOGISTICS_DELIVERY_STATUS_ROLES = ['DRIVER', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
