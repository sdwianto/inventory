/** App-layer shim — ERP hot-path Prometheus (gov-observability). */

export {
  normalizeHotpathRoute,
  recordHotpathHttp,
  recordIntegrationHold,
} from '@sdwianto/metrics';
export type { HotpathRoute, IntegrationHoldOp } from '@sdwianto/metrics';
