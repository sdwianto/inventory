/** Inventory app wrapper — seeds DEFAULT_INVENTORY_SCHEDULED_TASKS via platform */

import type { Db } from 'mongodb';
import {
  ensureDefaultScheduledTasks as ensurePlatformDefaultTasks,
  type SeedScheduledTasksResult,
} from '@sdwianto/platform/scheduler/seed-default-tasks';
import { DEFAULT_INVENTORY_SCHEDULED_TASKS } from './default-tasks';

export type { SeedScheduledTasksResult };

export async function ensureDefaultScheduledTasks(db: Db): Promise<SeedScheduledTasksResult> {
  return ensurePlatformDefaultTasks(db, DEFAULT_INVENTORY_SCHEDULED_TASKS);
}
