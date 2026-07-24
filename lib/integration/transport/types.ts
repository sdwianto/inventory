/**
 * Re-export shared transport contract (@sdwianto/integration) — Principal P4.
 * App HttpTransport still applies local bulkhead pool typing at call sites.
 */
export type {
  TransportMethod,
  TransportRequest,
  TransportResponse,
  IntegrationTransport,
} from '@sdwianto/integration';

export { jsonTransportResponse } from '@sdwianto/integration';
