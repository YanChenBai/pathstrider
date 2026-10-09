import type { StandardJSONSchemaV1, StandardTypedV1 } from '@standard-schema/spec';
import type { OpenAPIV3 } from 'openapi-types';

import type { RouteContract } from './server.ts';

function jsonSchema(schema: StandardTypedV1, io: 'input' | 'output'): Record<string, unknown> {
  const standard = schema['~standard'] as Partial<StandardJSONSchemaV1.Props>;
  const converter = standard.jsonSchema;
  if (!converter || typeof converter[io] !== 'function') {
    throw new Error(
      `Schema vendor '${standard.vendor}' must implement Standard JSON Schema ${io} conversion`,
    );
  }
  return converter[io]({ target: 'openapi-3.0' });
}

export async function generateOpenAPI(contract: RouteContract): Promise<OpenAPIV3.OperationObject> {
  const parameters: OpenAPIV3.ParameterObject[] = [];
  for (const location of ['query', 'headers'] as const) {
    const schema = contract.validate?.[location];
    if (!schema) continue;
    const json = jsonSchema(schema, 'input');
    if (json.type !== 'object' || !json.properties || typeof json.properties !== 'object') {
      throw new Error(`validate.${location} must produce an object JSON schema`);
    }
    const required = Array.isArray(json.required) ? json.required : [];
    for (const [name, property] of Object.entries(json.properties)) {
      parameters.push({
        name,
        in: location === 'headers' ? 'header' : 'query',
        required: required.includes(name),
        schema: property as OpenAPIV3.SchemaObject,
        ...(property && typeof property === 'object' && typeof property.description === 'string'
          ? { description: property.description }
          : {}),
      });
    }
  }
  const responses: OpenAPIV3.ResponsesObject = {};
  for (const [status, schema] of Object.entries(contract.responses ?? {})) {
    if (!schema) continue;
    if (!/^[1-5]\d{2}$/.test(status)) throw new Error(`Invalid response status: ${status}`);
    const json = jsonSchema(schema, 'output');
    responses[status] = {
      description: typeof json.description === 'string' ? json.description : `HTTP ${status}`,
      content: { 'application/json': { schema: json as OpenAPIV3.SchemaObject } },
    };
  }
  if (!Object.keys(responses).length) responses.default = { description: 'Response' };
  const body = contract.validate?.body;
  let requestBody: OpenAPIV3.RequestBodyObject | undefined;
  if (body) {
    const json = jsonSchema(body, 'input');
    const empty = await body['~standard'].validate(undefined);
    requestBody = {
      required: !!empty.issues,
      content: { 'application/json': { schema: json as OpenAPIV3.SchemaObject } },
    };
  }
  const extra = contract.openAPI ?? {};
  const overrides = extra.parameters ?? [];
  const merged = parameters.filter(
    parameter =>
      !overrides.some(
        override =>
          'in' in override && override.in === parameter.in && override.name === parameter.name,
      ),
  );
  return {
    ...(requestBody ? { requestBody } : {}),
    ...extra,
    parameters: [...merged, ...overrides],
    responses,
  };
}
