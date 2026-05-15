/**
 * Service-name mapping helpers — translate EKG Service node names to
 * external system identifiers (Datadog service tag, Splunk index, etc.).
 *
 * Pure / deterministic. No I/O.
 */

export type ServiceMapping =
  | 'auto'
  | { readonly field: string; readonly pattern: string };

const PLACEHOLDER = '{service}';

export function mapServiceName(service: string, mapping: ServiceMapping): string {
  if (!service) return service;
  if (mapping === 'auto') return service;
  if (!mapping.pattern.includes(PLACEHOLDER)) {
    // Unsupported / malformed pattern — fall back to identity rather than throw.
    return service;
  }
  return mapping.pattern.split(PLACEHOLDER).join(service);
}
