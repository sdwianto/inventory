export type UserRole =
  | 'MASTER'
  | 'ADMIN'
  | 'OWNER'
  | 'SUPERVISOR'
  | 'GUDANG';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
  tenantName: string;
  isMaster: boolean;
  isApiKey?: boolean;
  scopes?: string[];
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
  tenantName: string;
  actingTenantId?: string;
  actingTenantName?: string;
}

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
  tenantName: string;
  iat?: number;
  exp?: number;
}
