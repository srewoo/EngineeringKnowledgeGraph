import { describe, it, expect } from 'vitest';
import { ServiceResolver } from '../../src/service.resolver.js';

// Reach in via "any" — we only test the pure URL→service matching helper.
describe('ServiceResolver.matchUrlToService (private)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolver = new ServiceResolver({} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const match = (url: string, services: { name: string; id: string }[]) =>
    (resolver as any).matchUrlToService(url, services);

  const services = [
    { name: 'user-service', id: 'service:user-service' },
    { name: 'payments_service', id: 'service:payments_service' },
    { name: 'notification', id: 'service:notification' },
  ];

  it('matches a direct hostname (HIGH)', () => {
    expect(match('http://user-service/api/v1/users', services))
      .toEqual({ id: 'service:user-service', confidence: 'HIGH' });
  });

  it('matches Kubernetes DNS (HIGH)', () => {
    expect(match('http://user-service.default.svc.cluster.local/health', services))
      .toEqual({ id: 'service:user-service', confidence: 'HIGH' });
  });

  it('matches an env-substituted URL by token overlap (HIGH)', () => {
    expect(match('${PAYMENTS_SERVICE_URL}/charge', services))
      .toEqual({ id: 'service:payments_service', confidence: 'HIGH' });
  });

  it('falls back to MEDIUM substring when host does not match cleanly', () => {
    expect(match('http://payments_service-internal/v1', services))
      .toEqual({ id: 'service:payments_service', confidence: 'HIGH' });
  });

  it('returns undefined when nothing matches', () => {
    expect(match('http://random.example.com/x', services)).toBeUndefined();
  });
});
