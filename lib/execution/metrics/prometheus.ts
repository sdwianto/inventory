/**
 * EE-15 — prefer `@sdwianto/metrics` for facades.
 * `getExecutionMetricsSnapshot(db?)` stays Db-aware via platform wrapper.
 */
export * from '@sdwianto/platform/metrics/prometheus';
