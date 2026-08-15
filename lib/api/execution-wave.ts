/** EE-9C/9D/9E wave flags — EE-10 defaults to all types on VPS when JOB_BUS_ENABLED=1. */

import { loadPlatformConfig } from '@/lib/execution/runtime/config';

export function shouldUseLegacyBgPoll(): boolean {
  const config = loadPlatformConfig();
  if (!config.jobBusEnabled) return true;

  const legacy = (process.env.EXECUTION_LEGACY_BG || '').trim().toLowerCase();
  if (legacy === '1' || legacy === 'true' || legacy === 'yes') return true;

  if (process.env.VERCEL) return true;

  const mode = (process.env.DEPLOYMENT_MODE || '').trim().toLowerCase();
  return mode !== 'vps';
}

export const EXECUTION_WAVE_1_TYPES = new Set([
  'WEBHOOK_INBOX',
  'CATALOG_SYNC',
  'PO_VENDOR_SYNC',
  'HUTANG_SYNC',
]);

export const EXECUTION_WAVE_2_TYPES = new Set([
  'GRN_POST_SIDE_EFFECTS',
  'GRN_SYNC_SHIPPED',
  'GRN_RESOLVE_PRODUCTS',
  'GRN_INVOICE_SYNC',
  'GOODS_RETURN_CN_SYNC',
  'HUTANG_REPAIR',
  'HUTANG_BACKFILL',
]);

export const EXECUTION_WAVE_3_TYPES = new Set([
  'INTEGRATION_RECONCILE',
  'AUDIT_LOG_PURGE',
  'SANDBOX_RESET',
]);

const ALL_WAVE_TYPES = new Set([
  ...EXECUTION_WAVE_1_TYPES,
  ...EXECUTION_WAVE_2_TYPES,
  ...EXECUTION_WAVE_3_TYPES,
]);

function typesForWaveFlag(wave: string): Set<string> | null {
  if (!wave || wave === '0' || wave === 'off') return null;
  if (wave === 'all' || wave === '*') return ALL_WAVE_TYPES;
  if (wave === '1') return EXECUTION_WAVE_1_TYPES;
  if (wave === '2') return new Set([...EXECUTION_WAVE_1_TYPES, ...EXECUTION_WAVE_2_TYPES]);
  if (wave === '3') return new Set([
    ...EXECUTION_WAVE_1_TYPES,
    ...EXECUTION_WAVE_2_TYPES,
    ...EXECUTION_WAVE_3_TYPES,
  ]);
  return new Set(
    wave.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  );
}

export function shouldUseExecutionEnqueue(type: string): boolean {
  const config = loadPlatformConfig();
  if (!config.jobBusEnabled) return false;

  const normalized = type.toUpperCase();
  if (!ALL_WAVE_TYPES.has(normalized)) return false;

  if (!shouldUseLegacyBgPoll()) return true;

  const wave = (process.env.EXECUTION_WAVE || '').trim().toLowerCase();
  const enabled = typesForWaveFlag(wave);
  if (!enabled) return false;
  return enabled.has(normalized);
}

export function shouldProcessJobInline(type?: string): boolean {
  if (!shouldUseLegacyBgPoll()) return false;
  if (!type) return true;
  return !shouldUseExecutionEnqueue(type);
}
