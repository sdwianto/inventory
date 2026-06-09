// API key untuk integrasi eksternal (customer inventory app).

import crypto from 'crypto';

export function generateApiKey() {
  return `sk_${crypto.randomBytes(24).toString('hex')}`;
}

export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function resolveApiKeyAuth(db, request) {
  const raw = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!raw || !raw.startsWith('sk_')) return null;
  const keyHash = hashApiKey(raw);
  const doc = await db.collection('api_keys').findOne({ keyHash, aktif: { $ne: false } });
  if (!doc) return null;
  if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) return null;
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
