import type { H3Event } from 'nitro';
import { describe, expect, expectTypeOf, test, vi } from 'vite-plus/test';

import {
  type Client,
  type ClientError,
  ClientHTTPError,
  type ClientMethod,
  type ClientResult,
  type InferHandlerRequest,
  type InferHandlerResponse,
  isClientHTTPError,
  useClient,
} from '../src/client.ts';
import type { PathstriderError } from '../src/error.ts';

type NotFoundError = PathstriderError<'USER_NOT_FOUND', { userId: string }>;

interface TestRoutes {
  files(params: { path: string | string[] }): {
    get: ClientMethod<{}, string, 'GET'>;
  };
  users: {
    get: ClientMethod<
      {
        headers: { authorization: string };
        query: { page: number; tag?: string[] };
      },
      { id: string },
      'GET',
      ClientError<404, NotFoundError>
    >;
    post: ClientMethod<
      {
        body: { name: string };
        query: { notify?: boolean };
      },
      { id: string },
      'POST'
    >;
  };
}

function createMockClient(
  handler: (request: Request) => Response | Promise<Response>,
  options: Parameters<typeof useClient<TestRoutes>>[0] = {},
) {
  return useClient<TestRoutes>({
    baseUrl: 'https://example.test/api/',
    throwHttpErrors: false,
    ...options,
    fetch: async input => handler(input instanceof Request ? input : new Request(input)),
  });
}

describe('client', () => {
  test('sends typed query and headers through Ky', async () => {
    const api = createMockClient(request => {
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe('Bearer token');
      expect(request.url).toBe('https://example.test/api/users?page=2&tag=a&tag=b');

      return Response.json({ id: 'user-1' });
    });

    const result = await api.users.get({
      headers: { authorization: 'Bearer token' },
      query: { page: 2, tag: ['a', 'b'] },
    });

    expect(result).toMatchObject({
      data: { id: 'user-1' },
      error: null,
      status: 200,
    });
    await expect(result.response.json()).resolves.toEqual({ id: 'user-1' });
  });

  test('sends JSON bodies without leaking request options into the body', async () => {
    const api = createMockClient(async request => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://example.test/api/users?notify=true');
      await expect(request.json()).resolves.toEqual({ name: 'Ciel' });

      return Response.json({ id: 'user-2' }, { status: 201 });
    });

    const result = await api.users.post(
      { name: 'Ciel' },
      {
        query: { notify: true },
      },
    );

    expect(result.status).toBe(201);
    expect(result.data).toEqual({ id: 'user-2' });
  });

  test('encodes dynamic and catch-all path values', async () => {
    const api = createMockClient(request => {
      expect(request.url).toBe('https://example.test/api/files/a%20b/c%2Fd');

      return new Response('content');
    });

    const result = await api.files({ path: ['a b', 'c/d'] }).get();

    expect(result.data).toBe('content');
  });

  test('returns typed errors when HTTP throwing is disabled', async () => {
    const api = createMockClient(() => {
      return Response.json(
        {
          code: 'USER_NOT_FOUND',
          details: { userId: 'user-1' },
          message: 'User does not exist',
        },
        { status: 404 },
      );
    });

    const result = await api.users.get({
      headers: { authorization: 'Bearer token' },
      query: { page: 1 },
    });

    expect(result).toEqual(
      expect.objectContaining({
        data: null,
        error: {
          status: 404,
          value: {
            code: 'USER_NOT_FOUND',
            details: { userId: 'user-1' },
            message: 'User does not exist',
          },
        },
        status: 404,
      }),
    );
  });

  test('throws normalized HTTP errors by default after invoking hooks', async () => {
    const onResponseError = vi.fn();
    const api = createMockClient(
      () => Response.json({ message: 'legacy error' }, { status: 502 }),
      {
        pathstriderHooks: { onResponseError },
        throwHttpErrors: true,
      },
    );

    const request = api.users.get({
      headers: { authorization: 'Bearer token' },
      query: { page: 1 },
    });

    await expect(request).rejects.toMatchObject({
      status: 502,
      value: {
        code: 'UNEXPECTED_RESPONSE',
        message: 'Received an unexpected error response',
      },
    });
    expect(onResponseError).toHaveBeenCalledOnce();

    await request.catch(error => {
      expect(error).toBeInstanceOf(ClientHTTPError);
      expect(isClientHTTPError(error)).toBe(true);
    });
  });

  test('reports request failures separately from response errors', async () => {
    const failure = new Error('offline');
    const onRequestError = vi.fn();
    const api = useClient<TestRoutes>({
      baseUrl: 'https://example.test/api/',
      fetch: async () => {
        throw failure;
      },
      pathstriderHooks: { onRequestError },
    });

    const request = api.users.get({
      headers: { authorization: 'Bearer token' },
      query: { page: 1 },
    });

    await expect(request).rejects.toBe(failure);
    expect(onRequestError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: failure,
      }),
    );
  });

  test('handles responses without a body', async () => {
    const api = createMockClient(() => new Response(null, { status: 204 }));

    const result = await api.users.get({
      headers: { authorization: 'Bearer token' },
      query: { page: 1 },
    });

    expect(result.data).toBeUndefined();
  });

  test('passes Ky options and hooks through useClient', async () => {
    const beforeRequest = vi.fn(({ request }: { request: Request }) => {
      request.headers.set('x-client', 'pathstrider');
    });
    const api = createMockClient(
      request => {
        expect(request.headers.get('authorization')).toBe('Bearer default');
        expect(request.headers.get('x-client')).toBe('pathstrider');
        expect(request.url).toBe('https://example.test/api/v2/users?page=1');

        return Response.json({ id: 'user-1' });
      },
      {
        headers: {
          authorization: 'Bearer default',
        },
        hooks: {
          beforeRequest: [beforeRequest],
        },
        prefix: 'v2',
      },
    );

    await api.users.get({
      query: { page: 1 },
    });

    expect(beforeRequest).toHaveBeenCalledOnce();
  });

  test('does not expose a thenable proxy', () => {
    const api = createMockClient(() => Response.json({}));

    expect(Reflect.get(api, 'then')).toBeUndefined();
  });
});

test('ClientResult narrows success and error branches', () => {
  const read = (result: ClientResult<{ id: string }, ClientError<404, NotFoundError>>) => {
    if (result.error) {
      return result.error.value.details.userId;
    }

    return result.data.id;
  };

  expect(read).toBeTypeOf('function');
});

test('extracts throwable client errors from route methods', () => {
  type Error = Client.Error<TestRoutes['users']['get']>;

  expectTypeOf<Error>().toEqualTypeOf<ClientHTTPError<404, NotFoundError>>();
});

test('infers plain Nitro handler functions', () => {
  type Request = {
    query: {
      id: string;
    };
  };
  type Handler = (event: H3Event<Request>) => Promise<{ id: string }>;

  expectTypeOf<InferHandlerRequest<Handler>>().toEqualTypeOf<Request>();
  expectTypeOf<InferHandlerResponse<Handler>>().toEqualTypeOf<{ id: string }>();
});
