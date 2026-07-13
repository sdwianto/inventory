#!/usr/bin/env node
/**
 * EE-12 Phase 3 — replace duplicate lib/execution runtime with @dawam/platform shims.
 *
 * Usage: node scripts/ee12-consume-platform.mjs
 * Prerequisite: npm run ee12:vendor-platform
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const LIB = join(ROOT, 'lib/execution');

const SOURCE_CANDIDATES = [
  join(ROOT, '../../sales/sales/packages'),
  join(ROOT, '_vendor/sales/packages'),
];

function findSourcePackages() {
  for (const base of SOURCE_CANDIDATES) {
    if (existsSync(join(base, 'contracts/package.json')) && existsSync(join(base, 'platform/package.json'))) {
      return base;
    }
  }
  return null;
}

const SHIM_DIRS = [
  'queue',
  'runtime',
  'scheduler',
  'dispatcher',
  'bus',
  'locks',
  'retry',
  'heartbeat',
  'recovery',
  'metrics',
  'events',
  'tracing',
  'ops',
];

const SKIP_SCHEDULER = new Set(['default-tasks.ts', 'seed-default-tasks.ts']);
const SKIP_WORKERS = new Set(['register-inventory.ts', 'register-all.ts']);
const KEEP_CONTRACTS = true;

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

function writeShim(file, platformSubpath) {
  const content = `/** @deprecated import from \`@dawam/platform/${platformSubpath}\` — EE-12 Phase 3 shim */\nexport * from '@dawam/platform/${platformSubpath}';\n`;
  writeFileSync(file, content, 'utf8');
}

function writeContractShims() {
  const contractsDir = join(LIB, 'contracts');
  const shims = {
    'job.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport type {\n  Job,\n  JobStatus,\n  JobDomain,\n  JobPriority,\n  JobClassification,\n  FailureClass,\n  FailureCategory,\n  WorkerCapability,\n  WorkerState,\n  JobCheckpoint,\n  EnqueueInput,\n  EnqueueResult,\n} from '@dawam/contracts';\nexport { JOB_SCHEMA_VERSION } from '@dawam/contracts';\n`,
    'context.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport type {\n  ExecutionContext,\n  ExecutionLogger,\n  ExecutionMetricsFacade,\n  ExecutionRedisClient,\n  FailOptions,\n} from '@dawam/contracts';\n`,
    'errors.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport {\n  JobNotFoundError,\n  InvalidTransitionError,\n  JobTransitionConflictError,\n  JobNotRunnableError,\n  WorkerMismatchError,\n  LockNotHeldError,\n  PlatformShutdownError,\n  PlatformRecoveryError,\n  HandlerNotRegisteredError,\n  PlatformVersionSkewError,\n  PlatformConfigError,\n  ValidationError,\n  AuthError,\n  ConflictError,\n  DependencyError,\n} from '@dawam/contracts';\n`,
    'transitions.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport {\n  ALLOWED_TRANSITIONS,\n  isTransitionAllowed,\n  assertTransitionAllowed,\n  assertAnyTransitionAllowed,\n} from '@dawam/contracts';\n`,
    'transition-patch.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport type { TransitionPatch } from '@dawam/contracts';\nexport { assertTransitionPatch } from '@dawam/contracts';\n`,
    'job-type-defaults.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport {\n  JOB_TYPE_DEFAULTS,\n  JOB_REQUIRED_CAPABILITIES,\n  getJobTypeDefaults,\n} from '@dawam/contracts';\nexport type { JobTypeDefaults } from '@dawam/contracts';\n`,
    'platform-version.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport {\n  getExecutionPlatformVersion,\n  platformVersionMajor,\n  isPlatformVersionSkew,\n} from '@dawam/contracts';\n`,
    'scheduled-task.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport type {\n  ScheduledTask,\n  ScheduledTaskInput,\n  SchedulerCycleResult,\n} from '@dawam/contracts';\nexport { DEFAULT_SCHEDULER_TZ_OFFSET_MIN } from '@dawam/contracts';\n`,
    'api-types.ts': `/** @deprecated import from \`@dawam/contracts\` — EE-12 shim */\nexport type {\n  ClaimOptions,\n  FailResult,\n  ListDlqOptions,\n  HeartbeatInput,\n  FailOptions,\n} from '@dawam/contracts';\n`,
    'index.ts': `/** Re-exports \`@dawam/contracts\` — EE-12 Phase 3 shim */\nexport type {\n  Job,\n  JobStatus,\n  JobDomain,\n  JobPriority,\n  JobClassification,\n  FailureClass,\n  FailureCategory,\n  WorkerCapability,\n  WorkerState,\n  JobCheckpoint,\n  EnqueueInput,\n  EnqueueResult,\n  TransitionPatch,\n  ExecutionContext,\n  ExecutionLogger,\n  ExecutionMetricsFacade,\n  ExecutionRedisClient,\n  FailOptions,\n  ScheduledTask,\n  ScheduledTaskInput,\n  SchedulerCycleResult,\n  ClaimOptions,\n  FailResult,\n  ListDlqOptions,\n  HeartbeatInput,\n  JobTypeDefaults,\n} from '@dawam/contracts';\n\nexport { JOB_SCHEMA_VERSION } from '@dawam/contracts';\nexport { assertTransitionPatch } from '@dawam/contracts';\nexport {\n  ALLOWED_TRANSITIONS,\n  isTransitionAllowed,\n  assertTransitionAllowed,\n  assertAnyTransitionAllowed,\n} from '@dawam/contracts';\nexport {\n  getExecutionPlatformVersion,\n  platformVersionMajor,\n  isPlatformVersionSkew,\n} from '@dawam/contracts';\nexport {\n  JOB_TYPE_DEFAULTS,\n  JOB_REQUIRED_CAPABILITIES,\n  getJobTypeDefaults,\n} from '@dawam/contracts';\nexport {\n  JobNotFoundError,\n  InvalidTransitionError,\n  JobTransitionConflictError,\n  JobNotRunnableError,\n  WorkerMismatchError,\n  LockNotHeldError,\n  PlatformShutdownError,\n  HandlerNotRegisteredError,\n  PlatformVersionSkewError,\n  PlatformConfigError,\n} from '@dawam/contracts';\nexport { DEFAULT_SCHEDULER_TZ_OFFSET_MIN } from '@dawam/contracts';\n`,
  };
  for (const [name, content] of Object.entries(shims)) {
    writeFileSync(join(contractsDir, name), content, 'utf8');
  }
}

function generateRuntimeShims() {
  for (const d of SHIM_DIRS) {
    const libDir = join(LIB, d);
    if (!existsSync(libDir)) continue;
    for (const file of listTsFiles(libDir)) {
      const base = file.split('/').pop() || '';
      if (d === 'scheduler' && SKIP_SCHEDULER.has(base)) continue;
      const rel = relative(LIB, file).replace(/\\/g, '/').replace(/\.ts$/, '');
      writeShim(file, rel);
    }
  }
  const registry = join(LIB, 'workers/registry.ts');
  if (existsSync(registry)) writeShim(registry, 'workers/registry');
}

function writeSeedWrapper() {
  const content = `/** Inventory app wrapper — seeds DEFAULT_INVENTORY_SCHEDULED_TASKS via platform */\n\nimport type { Db } from 'mongodb';\nimport {\n  ensureDefaultScheduledTasks as ensurePlatformDefaultTasks,\n  type SeedScheduledTasksResult,\n} from '@dawam/platform/scheduler/seed-default-tasks';\nimport { DEFAULT_INVENTORY_SCHEDULED_TASKS } from './default-tasks';\n\nexport type { SeedScheduledTasksResult };\n\nexport async function ensureDefaultScheduledTasks(db: Db): Promise<SeedScheduledTasksResult> {\n  return ensurePlatformDefaultTasks(db, DEFAULT_INVENTORY_SCHEDULED_TASKS);\n}\n`;
  writeFileSync(join(LIB, 'scheduler/seed-default-tasks.ts'), content, 'utf8');
}

function writeApiTs() {
  const api = `/** Public execution surface — EE-12 Phase 3: platform + inventory handlers */\n\nexport * from '@dawam/platform';\nexport { ensureDefaultScheduledTasks } from '@/lib/execution/scheduler/seed-default-tasks';\nexport type { SeedScheduledTasksResult } from '@/lib/execution/scheduler/seed-default-tasks';\nexport { registerInventoryHandlers } from '@/lib/execution/workers/register-inventory';\n`;
  writeFileSync(join(LIB, 'api.ts'), api, 'utf8');
}

function main() {
  const hasPackages =
    existsSync(join(ROOT, 'node_modules/@dawam/contracts/package.json'))
    || existsSync(join(ROOT, 'vendor/contracts/package.json'))
    || findSourcePackages();
  if (!hasPackages) {
    console.error('[ee12-consume] run: npm run ee12:install-platform');
    process.exit(1);
  }
  console.info('[ee12-consume] writing contract shims');
  writeContractShims();
  console.info('[ee12-consume] writing runtime shims → @dawam/platform');
  generateRuntimeShims();
  writeSeedWrapper();
  writeApiTs();
  console.info('[ee12-consume] done — run: npm run typecheck:packages && npm run typecheck');
}

main();
