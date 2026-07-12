/** Public execution surface — EE-12 Phase 3: platform + inventory handlers */

export * from '@dawam/platform';
export { ensureDefaultScheduledTasks } from '@/lib/execution/scheduler/seed-default-tasks';
export type { SeedScheduledTasksResult } from '@/lib/execution/scheduler/seed-default-tasks';
export { registerInventoryHandlers } from '@/lib/execution/workers/register-inventory';
