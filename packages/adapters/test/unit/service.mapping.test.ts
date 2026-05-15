import { describe, it, expect } from 'vitest';
import { mapServiceName } from '../../src/service.mapping.js';

describe('mapServiceName', () => {
  it('returns identity for auto', () => {
    expect(mapServiceName('person-service', 'auto')).toBe('person-service');
  });

  it('expands the {service} placeholder', () => {
    expect(
      mapServiceName('coaching', { field: 'index', pattern: 'app-{service}' }),
    ).toBe('app-coaching');
  });

  it('expands multiple occurrences', () => {
    expect(
      mapServiceName('x', { field: 'index', pattern: '{service}-svc-{service}' }),
    ).toBe('x-svc-x');
  });

  it('falls back to identity on unsupported pattern', () => {
    expect(
      mapServiceName('foo', { field: 'index', pattern: 'no-placeholder-here' }),
    ).toBe('foo');
  });

  it('returns empty input as-is', () => {
    expect(mapServiceName('', 'auto')).toBe('');
  });
});
