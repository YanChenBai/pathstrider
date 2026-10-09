import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { defineValidatedHandler } from '../src/server.ts';

describe('defineValidatedHandler', () => {
  it('preserves transformed query and header outputs', async () => {
    const handler = defineValidatedHandler({
      validate: {
        query: z.object({ count: z.coerce.number().default(2) }),
        headers: z.object({ 'x-count': z.coerce.number() }),
      },
      handler: ({ query, headers }) => ({ count: query.count + headers['x-count'] }),
    });
    const response = await handler.fetch(
      new Request('http://localhost/?count=3', { headers: { 'x-count': '4' } }),
    );
    expect(await response.json()).toEqual({ count: 7 });
  });

  it('validates async body schemas and invokes the handler once', async () => {
    let calls = 0;
    const handler = defineValidatedHandler({
      validate: {
        body: z.object({ name: z.string().transform(async value => value.toUpperCase()) }),
      },
      handler: ({ body }) => {
        calls++;
        return body;
      },
    });
    const response = await handler.fetch(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Codex' }),
      }),
    );
    expect(await response.json()).toEqual({ name: 'CODEX' });
    expect(calls).toBe(1);
  });

  it('rejects invalid requests and preserves custom validation status', async () => {
    let called = false;
    const handler = defineValidatedHandler({
      validate: {
        query: z.object({ name: z.string() }),
        onError: error => ({ status: 422, message: `Invalid ${error._source}` }),
      },
      handler: () => {
        called = true;
        return 'ok';
      },
    });
    const response = await handler.fetch('http://localhost/');
    expect(response.status).toBe(422);
    expect(called).toBe(false);
  });
});
