/** MASTER ops dashboard — Inventory (P2.3a). */

import type { NextResponse } from 'next/server';
import type { HandlerContext } from '@/types/api/handler';
import { ok, clean } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import { buildHealthResponse } from '@/lib/api/health';

export async function handleOpsDashboard(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, route, method, auth } = ctx;
  if (route !== '/ops/dashboard' || method !== 'GET') return null;

  const denied = requireRole(auth, ['MASTER']);
  if (denied) return denied;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [health, failedWebhooks, pendingJobs, deadLetterJobs, recentAudit] = await Promise.all([
    buildHealthResponse(db, 'inventory'),
    db.collection('webhook_inbox')
      .find({ status: 'FAILED', createdAt: { $gte: since24h } })
      .sort({ createdAt: -1 })
      .limit(25)
      .project({ id: 1, event: 1, tenantId: 1, status: 1, lastError: 1, createdAt: 1 })
      .toArray(),
    db.collection('bg_jobs')
      .find({ status: 'PENDING' })
      .sort({ createdAt: 1 })
      .limit(20)
      .project({ id: 1, type: 1, tenantId: 1, status: 1, attempts: 1, createdAt: 1, nextRunAt: 1 })
      .toArray(),
    db.collection('bg_jobs')
      .find({ status: 'FAILED', deadLetter: true })
      .sort({ updatedAt: -1 })
      .limit(15)
      .project({ id: 1, type: 1, tenantId: 1, lastError: 1, updatedAt: 1 })
      .toArray(),
    db.collection('audit_log')
      .find({ createdAt: { $gte: since24h } })
      .sort({ createdAt: -1 })
      .limit(15)
      .project({ id: 1, action: 1, summary: 1, tenantId: 1, userName: 1, createdAt: 1 })
      .toArray(),
  ]);

  return ok({
    health,
    failedWebhooks: failedWebhooks.map(clean),
    pendingJobs: pendingJobs.map(clean),
    deadLetterJobs: deadLetterJobs.map(clean),
    recentAudit: recentAudit.map(clean),
    salesHealthUrl: process.env.SALES_APP_URL
      ? `${String(process.env.SALES_APP_URL).replace(/\/$/, '')}/api/health`
      : null,
  });
}
