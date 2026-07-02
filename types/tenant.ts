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
  createdAt?: Date;
  updatedAt?: Date;
}
