// API key untuk integrasi eksternal (customer inventory app).

import crypto from 'crypto';
import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';

export function generateApiKey(): string {
  return `sk_${crypto.randomBytes(24).toString('hex')}`;
}

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface ApiKeyDoc {
  id: string;
  keyHash: string;
  aktif?: boolean;
  expiresAt?: string | Date;
  label?: string;
  role?: string;
  tenantId: string;
  tenantName?: string;
  scopes?: string[];
}

export async function resolveApiKeyAuth(db: Db, request: Request): Promise<AuthContext | null> {
  const raw = request.headers.get('x-api-key')
    || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!raw || !raw.startsWith('sk_')) return null;
  const keyHash = hashApiKey(raw);
  const doc = await db.collection<ApiKeyDoc>('api_keys').findOne({ keyHash, aktif: { $ne: false } });
  if (!doc) return null;
  if (doc.expiresAt && new Date(String(doc.expiresAt)) < new Date()) return null;
  return {
    userId: `apikey:${doc.id}`,
    email: 'integration@api',
    name: doc.label || 'API Integration',
    role: doc.role || 'ADMIN',
    tenantId: doc.tenantId,
    tenantName: doc.tenantName || doc.tenantId,
    isMaster: false,
    isApiKey: true,
    scopes: doc.scopes || ['integrations'],
  };
}
