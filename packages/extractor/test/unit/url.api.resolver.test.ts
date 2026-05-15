import { describe, it, expect } from 'vitest';
import { UrlApiResolver, type ApiCandidate, type HttpCallInput } from '../../src/url.api.resolver.js';

const resolver = new UrlApiResolver();

const apiUsersGet: ApiCandidate = {
  apiId: 'api:GET:/api/v1/users/{id}',
  serviceName: 'users-service',
  hosts: [],
  method: 'GET',
  pathTemplate: '/api/v1/users/{id}',
};
const apiUsersList: ApiCandidate = {
  apiId: 'api:GET:/api/v1/users',
  serviceName: 'users-service',
  hosts: [],
  method: 'GET',
  pathTemplate: '/api/v1/users',
};
const apiBillingCharge: ApiCandidate = {
  apiId: 'api:POST:/api/v1/charge',
  serviceName: 'billing-service',
  hosts: [],
  method: 'POST',
  pathTemplate: '/api/v1/charge',
};

function call(url: string, method = 'GET', isTemplate = false): HttpCallInput {
  return {
    url, method, sourceLine: 10, filePath: 'a.ts', isTemplate, clientLibrary: 'axios',
    callerSymbolId: 'fn:f:caller:1',
  };
}

describe('UrlApiResolver', () => {
  it('exact host + unique path match → HIGH', () => {
    const out = resolver.resolve({
      httpCalls: [call('https://users-service.internal/api/v1/users/42')],
      apis: [apiUsersGet, apiUsersList, apiBillingCharge],
      serviceHosts: { 'users-service': ['users-service.internal'] },
    });
    expect(out.resolved.length).toBe(1);
    expect(out.resolved[0]?.apiId).toBe(apiUsersGet.apiId);
    expect(out.resolved[0]?.confidence).toBe('HIGH');
  });

  it('fuzzy host match (no config) → MEDIUM', () => {
    const out = resolver.resolve({
      httpCalls: [call('https://billing-service.cluster.local/api/v1/charge', 'POST')],
      apis: [apiBillingCharge, apiUsersList],
    });
    expect(out.resolved.length).toBe(1);
    expect(out.resolved[0]?.apiId).toBe(apiBillingCharge.apiId);
    expect(out.resolved[0]?.confidence).toBe('MEDIUM');
  });

  it('template URL with path-only match → MEDIUM', () => {
    const out = resolver.resolve({
      httpCalls: [call('{var}/api/v1/users/{var}', 'GET', true)],
      apis: [apiUsersGet, apiBillingCharge],
    });
    expect(out.resolved.length).toBe(1);
    expect(out.resolved[0]?.apiId).toBe(apiUsersGet.apiId);
    expect(out.resolved[0]?.confidence).toBe('MEDIUM');
  });

  it('multi-candidate path picks the most specific by literal segment count', () => {
    const ambiguous: ApiCandidate = {
      apiId: 'api:GET:/{a}/{b}/{c}/{d}',
      hosts: [],
      method: 'GET',
      pathTemplate: '/{a}/{b}/{c}/{d}',
    };
    const out = resolver.resolve({
      httpCalls: [call('{var}/api/v1/users/42', 'GET', true)],
      apis: [ambiguous, apiUsersGet],
    });
    // Both match — apiUsersGet has 3 literal segments vs 0 for ambiguous.
    expect(out.resolved[0]?.apiId).toBe(apiUsersGet.apiId);
  });

  it('no path match → unresolved', () => {
    const out = resolver.resolve({
      httpCalls: [call('https://x.io/totally/different')],
      apis: [apiUsersGet, apiBillingCharge],
    });
    expect(out.resolved.length).toBe(0);
    expect(out.unresolved.length).toBe(1);
  });

  it('LOW confidence (no host match, with strict) goes to unresolved', () => {
    const out = resolver.resolve({
      httpCalls: [call('https://unknown.host.example.org/api/v1/users/9')],
      apis: [apiUsersGet],
      strict: true,
    });
    expect(out.resolved.length).toBe(0);
    expect(out.unresolved.length).toBe(1);
  });
});
