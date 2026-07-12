/** Re-exports `@dawam/contracts` — EE-12 Phase 3 shim */
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
} from '@dawam/contracts';

export { JOB_SCHEMA_VERSION } from '@dawam/contracts';
export { assertTransitionPatch } from '@dawam/contracts';
export {
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  assertTransitionAllowed,
  assertAnyTransitionAllowed,
} from '@dawam/contracts';
export {
  getExecutionPlatformVersion,
  platformVersionMajor,
  isPlatformVersionSkew,
} from '@dawam/contracts';
export {
  JOB_TYPE_DEFAULTS,
  JOB_REQUIRED_CAPABILITIES,
  getJobTypeDefaults,
} from '@dawam/contracts';
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
} from '@dawam/contracts';
export { DEFAULT_SCHEDULER_TZ_OFFSET_MIN } from '@dawam/contracts';
