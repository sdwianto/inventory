/** Re-exports `@sdwianto/contracts` — EE-12 Phase 3 shim */
export type {
  Job,
  JobStatus,
  JobDomain,
  JobPriority,
  JobClassification,
  FailureClass,
  FailureCategory,
  WorkerCapability,
  WorkerState,
  JobCheckpoint,
  EnqueueInput,
  EnqueueResult,
  TransitionPatch,
  ExecutionContext,
  ExecutionLogger,
  ExecutionMetricsFacade,
  ExecutionRedisClient,
  FailOptions,
  ScheduledTask,
  ScheduledTaskInput,
  SchedulerCycleResult,
  ClaimOptions,
  FailResult,
  ListDlqOptions,
  HeartbeatInput,
  JobTypeDefaults,
} from '@sdwianto/contracts';

export { JOB_SCHEMA_VERSION } from '@sdwianto/contracts';
export { assertTransitionPatch } from '@sdwianto/contracts';
export {
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  assertTransitionAllowed,
  assertAnyTransitionAllowed,
} from '@sdwianto/contracts';
export {
  getExecutionPlatformVersion,
  platformVersionMajor,
  isPlatformVersionSkew,
} from '@sdwianto/contracts';
export {
  JOB_TYPE_DEFAULTS,
  JOB_REQUIRED_CAPABILITIES,
  getJobTypeDefaults,
} from '@sdwianto/contracts';
export {
  JobNotFoundError,
  InvalidTransitionError,
  JobTransitionConflictError,
  JobNotRunnableError,
  WorkerMismatchError,
  LockNotHeldError,
  PlatformShutdownError,
  HandlerNotRegisteredError,
  PlatformVersionSkewError,
  PlatformConfigError,
} from '@sdwianto/contracts';
export { DEFAULT_SCHEDULER_TZ_OFFSET_MIN } from '@sdwianto/contracts';
