import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { expect, test } from 'vite-plus/test';

import { generateOpenAPI } from '../src/openapi.ts';

test('uses Standard JSON Schema input/output converters without vendor-specific APIs', async () => {
  const conversions: string[] = [];
  const schema: StandardSchemaV1 & StandardJSONSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'custom-vendor',
      validate: async value => ({ value }),
      jsonSchema: {
        input: options => {
          conversions.push(`input:${options.target}`);
          return { type: 'string', description: 'Request input' };
        },
        output: options => {
          conversions.push(`output:${options.target}`);
          return { type: 'number', description: 'Converted response' };
        },
      },
    },
  };
  const operation = await generateOpenAPI({
    validate: { body: schema },
    responses: { 200: schema },
  });
  expect(operation.requestBody).toMatchObject({
    required: false,
    content: { 'application/json': { schema: { type: 'string' } } },
  });
  expect(operation.responses[200]).toMatchObject({
    description: 'Converted response',
    content: { 'application/json': { schema: { type: 'number' } } },
  });
  expect(conversions).toEqual(['output:openapi-3.0', 'input:openapi-3.0']);
});

test('reports missing Standard JSON Schema converters clearly', async () => {
  const schema: StandardSchemaV1 = {
    '~standard': { version: 1, vendor: 'validation-only', validate: value => ({ value }) },
  };
  await expect(generateOpenAPI({ responses: { 200: schema } })).rejects.toThrow(
    "Schema vendor 'validation-only' must implement Standard JSON Schema output conversion",
  );
});
