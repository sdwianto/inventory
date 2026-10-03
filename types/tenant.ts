export type TenantId = string;

export interface TenantSettings {
  id?: string;
  tenantId: TenantId;
  companyName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyNPWP?: string;
  receiptFooterText?: string;
  showLogoOnReceipt?: boolean;
  showLogoOnInvoice?: boolean;
  logoBase64?: string;
  logoUrl?: string;
  ppnPercent?: number;
  /** Status pajak tenant sebagai pembeli; lihat `lib/api/tenant-tax.ts`. */
  tax?: { pkp: boolean; pkpSejak: Date | string | null };
  createdAt?: Date;
  updatedAt?: Date;
}
