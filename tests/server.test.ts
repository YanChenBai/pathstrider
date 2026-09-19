import type { StandardSchemaV1 } from '@standard-schema/spec';
import { useRuntimeConfig } from 'nitro/runtime-config';
import { describe, expect, expectTypeOf, test, vi } from 'vite-plus/test';

import type { PathstriderError, ValidationError } from '../src/error.ts';
import {
  type ClientErrorResponse,
  defineTypedHandler,
  type TypedRouteHandler,
} from '../src/server.ts';

function schema<Input, Output = Input>(
  validate: (value: unknown) => StandardSchemaV1.Result<Output>,
): StandardSchemaV1<Input, Output> {
  return {
    '~standard': {
      validate,
      vendor: 'pathstrider-test',
      version: 1,
    },
  };
}

const querySchema = schema<unknown, { id: string; tags: string[] }>(value => {
  const query = value as Record<string, string | string[]>;

  if (typeof query.id === 'string' && Array.isArray(query.tag)) {
    return { value: { id: query.id, tags: query.tag } };
  }

  return { issues: [{ message: 'Expected id and repeated tag values.' }] };
});

describe('defineTypedHandler', () => {
  test('validates request schemas with a shorthand 200 response schema', async () => {
    const handler = defineTypedHandler(
      ({ body, headers, query }) => ({
        id: query.id,
        name: body.name,
        requestId: headers.requestId,
        tags: query.tags,
      }),
      {
        body: schema<unknown, { name: string }>(value => ({
          value: value as { name: string },
        })),
        headers: schema<unknown, { requestId: string }>(value => {
          const headers = value as Record<string, string>;

          return { value: { requestId: headers['x-request-id'] } };
        }),
        query: querySchema,
        response: schema(value => ({ value })),
      },
    );

    const response = await handler.fetch(
      new Request('https://example.test/api/user?id=1&tag=a&tag=b', {
        body: JSON.stringify({ name: 'Ciel' }),
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'request-1',
        },
        method: 'POST',
      }),
    );

    await expect(response.json()).resolves.toEqual({
      id: '1',
      name: 'Ciel',
      requestId: 'request-1',
      tags: ['a', 'b'],
    });
  });

  test('returns validation failures using the fixed error structure', async () => {
    const handler = defineTypedHandler(() => ({ ok: true }), {
      query: querySchema,
    });
    const response = await handler.fetch('https://example.test/api/user');

    expect(response.status).toBe(422);
    expect(response.headers.get('x-pathstrider-error')).toBe('1');
    await expect(response.json()).resolves.toEqual({
      code: 'VALIDATION_ERROR',
      details: {
        issues: [{ message: 'Expected id and repeated tag values.' }],
        target: 'query',
      },
      message: 'Request validation failed',
    });
  });

  test('treats malformed JSON bodies as request validation errors', async () => {
    const handler = defineTypedHandler(() => ({ ok: true }), {
      body: schema(value => ({ value })),
    });
    const response = await handler.fetch(
      new Request('https://example.test/api/user', {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: {
        issues: [{ message: 'Request body must contain valid JSON' }],
        target: 'body',
      },
    });
  });

  test('uses status mapped schemas for inference without validating error responses', async () => {
    const errorSchema = schema<
      PathstriderError<'USER_NOT_FOUND', { userId: string }>,
      { transformed: true }
    >(() => {
      throw new Error('Error response schemas must not run yet.');
    });
    const responseSchema = schema<unknown, { id: string }>(value => ({
      value: value as { id: string },
    }));
    const handler = defineTypedHandler(
      ({ status }) =>
        status(404, {
          code: 'USER_NOT_FOUND',
          details: { userId: 'user-1' },
          message: 'User does not exist',
        }),
      {
        response: {
          200: responseSchema,
          404: errorSchema,
        },
      },
    );

    const response = await handler.fetch('https://example.test/api/user-1');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: 'USER_NOT_FOUND',
      details: { userId: 'user-1' },
      message: 'User does not exist',
    });

    type HandlerErrors =
      typeof handler extends TypedRouteHandler<unknown, unknown, infer Errors> ? Errors : never;

    expectTypeOf<Extract<HandlerErrors, { status: 404 }>>().toMatchTypeOf<
      ClientErrorResponse<404, PathstriderError<'USER_NOT_FOUND', { userId: string }>>
    >();
  });

  test('does not validate successful responses by default', async () => {
    const validate = vi.fn(() => ({
      value: { id: 'transformed' },
    }));
    const handler = defineTypedHandler(() => ({ id: 'user-1' }), {
      response: schema<unknown, { id: string }>(validate),
    });

    const response = await handler.fetch('https://example.test/api/users');

    expect(validate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ id: 'user-1' });
  });

  test('validates successful responses when globally enabled', async () => {
    const validate = vi.fn((value: unknown) => ({
      value: { ...(value as { id: string }), transformed: true },
    }));
    const handler = defineTypedHandler(({ status }) => status(201, { id: 'user-1' }), {
      response: {
        201: schema<unknown, { id: string; transformed: boolean }>(validate),
      },
    });

    const runtimeConfig = useRuntimeConfig();
    const currentConfig = runtimeConfig.pathstrider;

    runtimeConfig.pathstrider = {
      validation: {
        response: true,
      },
    };

    const response = await handler.fetch('https://example.test/api/users');

    runtimeConfig.pathstrider = currentConfig;

    expect(response.status).toBe(201);
    expect(validate).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({ id: 'user-1', transformed: true });
  });

  test('turns invalid error values into internal errors', async () => {
    const invalidErrorHandler = defineTypedHandler(({ status }) =>
      status(404, {
        code: 'BROKEN',
      } as never),
    );
    const response = await invalidErrorHandler.fetch('https://example.test/api/test');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  });

  test('turns enabled response validation failures into internal errors', async () => {
    const handler = defineTypedHandler(() => ({ ok: true }), {
      response: schema(() => ({ issues: [{ message: 'Invalid response.' }] })),
    });
    const runtimeConfig = useRuntimeConfig();
    const currentConfig = runtimeConfig.pathstrider;

    runtimeConfig.pathstrider = {
      validation: {
        response: true,
      },
    };

    const response = await handler.fetch('https://example.test/api/test');

    runtimeConfig.pathstrider = currentConfig;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  });

  test('passes undefined to an optional body schema when the request has no body', async () => {
    const handler = defineTypedHandler(({ body }) => ({ body }), {
      body: schema<unknown, undefined>(value => ({ value: value as undefined })),
    });
    const response = await handler.fetch('https://example.test/api/user');

    await expect(response.json()).resolves.toEqual({});
  });

  test('passes raw values when schemas are omitted', async () => {
    const handler = defineTypedHandler(({ params, query }) => ({ params, query }));
    const response = await handler.fetch('https://example.test/api/user?name=Ciel');

    await expect(response.json()).resolves.toEqual({
      params: {},
      query: { name: 'Ciel' },
    });
  });

  test('includes validation errors in handler types when request schemas are present', () => {
    const handler = defineTypedHandler(() => ({ ok: true }), {
      query: querySchema,
    });

    type HandlerErrors =
      typeof handler extends TypedRouteHandler<unknown, unknown, infer Errors> ? Errors : never;

    expectTypeOf<Extract<HandlerErrors, { status: 422 }>>().toEqualTypeOf<
      ClientErrorResponse<422, ValidationError>
    >();
  });
});
