import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { extractContract } from '../src/extract.ts';
import { evaluateContract } from '../src/generator.ts';
import { generateOpenAPI } from '../src/openapi.ts';

describe('validated handler macro', () => {
  it('supports imported schemas, namespace imports and TypeScript wrappers', async () => {
    const source = extractContract(
      `
      import * as schemas from './fixtures/schemas';
      import type { RouteContract } from './handler';
      // 中文与 emoji 🐳 不影响源码区间
      export const response = schemas.greeting;
      export default defineValidatedHandler(({
        responses: { 200: response },
        handler() { throw new Error('business'); },
      } as const));
    `,
      'route.ts',
    );
    const contract = await evaluateContract(
      source!,
      fileURLToPath(new URL('./route.ts', import.meta.url)),
    );
    expect((await generateOpenAPI(contract)).responses[200]).toMatchObject({
      description: 'Imported greeting',
    });
  });
  it('extracts inline/local schemas without executing business imports or statements', async () => {
    const source = extractContract(
      `
      import { z } from 'zod';
      import { defineValidatedHandler as define } from './handler';
      import { database } from './nonexistent-business-module';
      throw new Error('must not execute');
      const output = z.object({ name: z.string() }).describe('Greeting');
      const options = {
        validate: { query: z.object({ name: z.string() }) },
        responses: { 200: output },
        openAPI: { tags: ['greeting'] },
        handler() { return database.query(); },
      };
      export default define(options);
    `,
      'route.ts',
    );
    expect(source).not.toContain('database');
    expect(source).not.toContain('must not execute');
    const contract = await evaluateContract(
      source!,
      fileURLToPath(new URL('./route.ts', import.meta.url)),
    );
    expect((await generateOpenAPI(contract)).responses[200]).toMatchObject({
      description: 'Greeting',
    });
  });

  it('generates required query/header/body inputs and schema descriptions', async () => {
    const result = await generateOpenAPI({
      validate: {
        query: z.object({
          name: z.string().describe('User name'),
          limit: z.string().default('10'),
        }),
        headers: z.object({ 'x-token': z.string() }),
        body: z.object({ message: z.string() }),
      },
      responses: {
        200: z.object({ name: z.string() }).describe('Success'),
        400: z.object({ error: z.string() }),
      },
      openAPI: { tags: ['test'] },
    });
    expect(result.parameters).toMatchObject([
      { name: 'name', in: 'query', required: true, description: 'User name' },
      { name: 'limit', in: 'query', required: false },
      { name: 'x-token', in: 'header', required: true },
    ]);
    expect(result.requestBody).toMatchObject({ required: true });
    expect(result.responses[200]).toMatchObject({
      description: 'Success',
      content: { 'application/json': { schema: { type: 'object' } } },
    });
    expect(result.responses[400]).toMatchObject({ description: 'HTTP 400' });
  });

  it('keeps automatic parameters when overriding one parameter', async () => {
    const result = await generateOpenAPI({
      validate: { query: z.object({ name: z.string(), other: z.string() }) },
      openAPI: { parameters: [{ name: 'name', in: 'query', description: 'Override' }] },
    });
    expect(result.parameters).toHaveLength(2);
    expect(result.parameters?.[1]).toMatchObject({ description: 'Override' });
  });

  it('fails loudly on unsupported schema conversion and spread options', async () => {
    await expect(
      generateOpenAPI({ responses: { 200: z.string().transform(value => value.length) } }),
    ).rejects.toThrow();
    expect(() =>
      extractContract('export default defineValidatedHandler({ ...options });', 'route.ts'),
    ).toThrow('spreads');
  });
});
