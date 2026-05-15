import { describe, it, expect } from 'vitest';
import { GrpcProtoExtractor } from '../../src/grpc.proto.extractor.js';
import type { ApiNode } from '@ekg/shared';

const REPO = 'https://gitlab.com/acme/svc';

function findApi(apis: readonly ApiNode[], operationId: string): ApiNode | undefined {
  return apis.find((a) => (a.properties as { operationId?: string }).operationId === operationId);
}

describe('GrpcProtoExtractor', () => {
  const extractor = new GrpcProtoExtractor();

  describe('handlesByPath()', () => {
    it('matches .proto', () => {
      expect(GrpcProtoExtractor.handlesByPath('a/b/users.proto')).toBe(true);
      expect(GrpcProtoExtractor.handlesByPath('users.PROTO')).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(GrpcProtoExtractor.handlesByPath('users.graphql')).toBe(false);
    });
  });

  it('emits GRPC_UNARY for plain rpc', () => {
    const proto = `
syntax = "proto3";
package mt.users.v1;
service UserService {
  rpc GetUser(GetUserRequest) returns (User);
}
`;
    const { apis } = extractor.extract(proto, 'svc/users.proto', REPO);
    expect(apis).toHaveLength(1);
    const op = findApi(apis, 'UserService.GetUser');
    expect(op).toBeDefined();
    const props = op!.properties as Record<string, unknown>;
    expect(props['method']).toBe('GRPC_UNARY');
    expect(props['path']).toBe('/mt.users.v1.UserService/GetUser');
    expect(props['specVersion']).toBe('grpc-proto3');
    expect(props['specPath']).toBe('svc/users.proto');
    expect((props['requestSchema'] as { messageType: string }).messageType).toBe('GetUserRequest');
    expect((props['responseSchemas'] as Record<string, { messageType: string }>)['200']!.messageType).toBe('User');
    expect(op!.id).toBe(`api:${REPO}:UserService.GetUser`);
  });

  it('classifies server-streaming rpc', () => {
    const proto = `
syntax = "proto3";
service S { rpc StreamUsers(Req) returns (stream User); }
`;
    const { apis } = extractor.extract(proto, 's.proto', REPO);
    const op = findApi(apis, 'S.StreamUsers');
    expect((op!.properties as Record<string, unknown>)['method']).toBe('GRPC_SERVER_STREAM');
    // No package — path should fall back to ServiceName/Method form.
    expect((op!.properties as Record<string, unknown>)['path']).toBe('S/StreamUsers');
  });

  it('classifies client-streaming rpc', () => {
    const proto = `
syntax = "proto3";
service S { rpc UploadUsers(stream UserChunk) returns (Status); }
`;
    const { apis } = extractor.extract(proto, 's.proto', REPO);
    const op = findApi(apis, 'S.UploadUsers');
    expect((op!.properties as Record<string, unknown>)['method']).toBe('GRPC_CLIENT_STREAM');
  });

  it('classifies bidirectional streaming rpc', () => {
    const proto = `
syntax = "proto3";
service Chatter { rpc Chat(stream Msg) returns (stream Msg); }
`;
    const { apis } = extractor.extract(proto, 'chat.proto', REPO);
    const op = findApi(apis, 'Chatter.Chat');
    expect((op!.properties as Record<string, unknown>)['method']).toBe('GRPC_BIDI_STREAM');
  });

  it('captures multi-line // doc comments', () => {
    const proto = `
syntax = "proto3";
service S {
  // GetUser fetches the canonical user record.
  // Reads from the primary; consider AvailableUser for replicas.
  rpc GetUser(Req) returns (User);
}
`;
    const { apis } = extractor.extract(proto, 's.proto', REPO);
    const op = findApi(apis, 'S.GetUser');
    const props = op!.properties as Record<string, unknown>;
    expect(props['summary']).toBe('GetUser fetches the canonical user record.');
    expect(props['description']).toContain('Reads from the primary');
  });

  it('honours proto2 syntax', () => {
    const proto = `
syntax = "proto2";
service S { rpc Ping(Req) returns (Resp); }
`;
    const { apis } = extractor.extract(proto, 's.proto', REPO);
    const props = apis[0]!.properties as Record<string, unknown>;
    expect(props['specVersion']).toBe('grpc-proto2');
  });

  it('parses multiple services in one file', () => {
    const proto = `
syntax = "proto3";
package mt.v1;
service A { rpc Foo(R) returns (R); }
service B {
  rpc Bar(R) returns (stream R);
  rpc Baz(stream R) returns (stream R);
}
`;
    const { apis } = extractor.extract(proto, 'multi.proto', REPO);
    expect(apis).toHaveLength(3);
    expect(findApi(apis, 'A.Foo')).toBeDefined();
    expect(findApi(apis, 'B.Bar')).toBeDefined();
    expect(findApi(apis, 'B.Baz')).toBeDefined();
    expect((findApi(apis, 'A.Foo')!.properties as Record<string, unknown>)['path']).toBe('/mt.v1.A/Foo');
  });

  it('handles rpc bodies with options blocks', () => {
    const proto = `
syntax = "proto3";
service S {
  rpc Get(R) returns (R) {
    option (google.api.http) = { get: "/v1/x" };
  }
}
`;
    const { apis } = extractor.extract(proto, 's.proto', REPO);
    expect(apis).toHaveLength(1);
    expect((apis[0]!.properties as Record<string, unknown>)['method']).toBe('GRPC_UNARY');
  });

  it('returns empty apis for non-proto content', () => {
    expect(extractor.extract('', 'x.proto', REPO).apis).toHaveLength(0);
    expect(extractor.extract('not a proto file', 'x.proto', REPO).apis).toHaveLength(0);
  });
});
