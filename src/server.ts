import type { StandardSchemaV1 } from '@standard-schema/spec';
import { defineHandler, HTTPError, type EventHandlerWithFetch, type H3Event } from 'nitro';
import { useRuntimeConfig } from 'nitro/runtime-config';

import {
  errorResponseHeader,
  type ErrorShape,
  type HTTPResponseError,
  type InternalServerError,
  isPathstriderError,
  type NotFoundError,
  type ValidationError,
  type ValidationIssue,
  type ValidationTarget,
} from './error.ts';

type SchemaInput<Schema, Fallback = unknown> = Schema extends StandardSchemaV1
  ? [Schema] extends [never]
    ? Fallback
    : StandardSchemaV1.InferInput<Schema>
  : Fallback;

type SchemaOutput<Schema, Fallback = unknown> = Schema extends StandardSchemaV1
  ? [Schema] extends [never]
    ? Fallback
    : StandardSchemaV1.InferOutput<Schema>
  : Fallback;

type SchemaAt<
  Schemas extends TypedHandlerSchemas,
  Key extends PropertyKey,
> = Key extends keyof Schemas ? Schemas[Key] : never;

type ResponseSchemaAt<Response, Status extends number> = Response extends StandardSchemaV1
  ? Status extends 200
    ? Response
    : never
  : Status extends keyof Response
    ? Response[Status]
    : never;

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

type StatusInput<Schemas extends TypedHandlerSchemas, Status extends number> = SchemaInput<
  ResponseSchemaAt<SchemaAt<Schemas, 'response'>, Status>,
  Status extends SuccessStatus ? unknown : ErrorShape
> &
  (Status extends SuccessStatus ? unknown : ErrorShape);

type ConfiguredStatuses<Response> = Response extends StandardSchemaV1
  ? 200
  : Extract<keyof Response, number>;

type ConfiguredResponse<Response, Status extends number> = Status extends SuccessStatus
  ? StatusResponse<Status, SchemaOutput<ResponseSchemaAt<Response, Status>>>
  : StatusResponse<Status, SchemaInput<ResponseSchemaAt<Response, Status>>>;

type ConfiguredResponses<Response> = {
  [Status in ConfiguredStatuses<Response>]: ConfiguredResponse<Response, Status>;
}[ConfiguredStatuses<Response>];

type HandlerStatusResponses<Response> = Extract<Awaited<Response>, StatusResponse<number, unknown>>;
type HandlerPlainResponse<Response> = Exclude<Awaited<Response>, StatusResponse<number, unknown>>;

type SuccessValues<Response> =
  Response extends StatusResponse<infer Status, infer Value>
    ? Status extends SuccessStatus
      ? Value
      : never
    : never;

type ErrorValues<Response> =
  Response extends StatusResponse<infer Status, infer Value>
    ? Status extends SuccessStatus
      ? never
      : ClientErrorResponse<Status, Value>
    : never;

type ConfiguredSuccess<Schemas extends TypedHandlerSchemas> = SuccessValues<
  ConfiguredResponses<SchemaAt<Schemas, 'response'>>
>;

type ConfiguredErrors<Schemas extends TypedHandlerSchemas> = ErrorValues<
  ConfiguredResponses<SchemaAt<Schemas, 'response'>>
>;

type HandlerSuccess<Response> =
  | HandlerPlainResponse<Response>
  | SuccessValues<HandlerStatusResponses<Response>>;

type ResolvedSuccess<Schemas extends TypedHandlerSchemas, Response> = [
  ConfiguredSuccess<Schemas>,
] extends [never]
  ? HandlerSuccess<Response>
  : ConfiguredSuccess<Schemas>;

type ResolvedErrors<Schemas extends TypedHandlerSchemas, Response> =
  | ClientErrorResponse<500, InternalServerError>
  | ConfiguredErrors<Schemas>
  | ErrorValues<HandlerStatusResponses<Response>>
  | (Extract<keyof Schemas, ValidationTarget> extends never
      ? never
      : ClientErrorResponse<422, ValidationError>);

const statusResponse = Symbol('pathstrider.status-response');

export interface ClientErrorResponse<Status extends number = number, Value = unknown> {
  status: Status;
  value: Value;
}

export interface StatusResponse<Status extends number = number, Value = unknown> {
  readonly [statusResponse]: true;
  readonly status: Status;
  readonly value: Value;
}

export interface StatusFunction<Schemas extends TypedHandlerSchemas> {
  <const Status extends number, const Value extends StatusInput<Schemas, Status>>(
    status: Status,
    value: Value,
  ): StatusResponse<Status, Value>;
}

export type ResponseSchemas = StandardSchemaV1 | Partial<Record<number, StandardSchemaV1>>;

export interface TypedHandlerSchemas {
  body?: StandardSchemaV1;
  headers?: StandardSchemaV1;
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  response?: ResponseSchemas;
}

export interface TypedHandlerContext<Schemas extends TypedHandlerSchemas> {
  body: SchemaOutput<SchemaAt<Schemas, 'body'>>;
  event: H3Event;
  headers: SchemaOutput<SchemaAt<Schemas, 'headers'>, Record<string, string>>;
  params: SchemaOutput<SchemaAt<Schemas, 'params'>, Record<string, string>>;
  query: SchemaOutput<SchemaAt<Schemas, 'query'>, Partial<Record<string, string | string[]>>>;
  status: StatusFunction<Schemas>;
}

export type TypedHandlerRequest<Schemas extends TypedHandlerSchemas> = {
  body: SchemaInput<SchemaAt<Schemas, 'body'>>;
  headers: SchemaInput<
    SchemaAt<Schemas, 'headers'>,
    Headers | Record<string, string> | readonly (readonly [string, string])[]
  >;
  params: SchemaInput<SchemaAt<Schemas, 'params'>, Record<string, string>>;
  query: SchemaInput<SchemaAt<Schemas, 'query'>, Partial<Record<string, string | string[]>>>;
};

export type TypedRouteHandler<Request, Response, Errors = never> = EventHandlerWithFetch & {
  readonly __pathstrider: {
    errors: Errors;
    request: Request;
    response: Response;
  };
};

export function defineTypedHandler<
  const Schemas extends TypedHandlerSchemas = {},
  Response = unknown,
>(
  handler: (context: TypedHandlerContext<Schemas>) => Response | Promise<Response>,
  schemas?: Schemas,
): TypedRouteHandler<
  TypedHandlerRequest<Schemas>,
  ResolvedSuccess<Schemas, Response>,
  ResolvedErrors<Schemas, Response>
> {
  const eventHandler = defineHandler(async event => {
    try {
      const body = schemas?.body
        ? await validateRequestSchema(schemas.body, await readRequestBody(event), 'body')
        : undefined;

      const rawQuery = getEventQuery(event);
      const query = schemas?.query
        ? await validateRequestSchema(schemas.query, rawQuery, 'query')
        : rawQuery;

      const rawParams = event.context.params ?? {};
      const params = schemas?.params
        ? await validateRequestSchema(schemas.params, rawParams, 'params')
        : rawParams;

      const rawHeaders = Object.fromEntries(event.req.headers);
      const headers = schemas?.headers
        ? await validateRequestSchema(schemas.headers, rawHeaders, 'headers')
        : rawHeaders;

      const result = await handler({
        body,
        event,
        headers,
        params,
        query,
        status,
      } as TypedHandlerContext<Schemas>);

      const statusCode = isStatusResponse(result) ? result.status : 200;
      const value = isStatusResponse(result) ? result.value : result;

      if (statusCode >= 300) {
        if (!isPathstriderError(value)) {
          return sendError(event, 500, createInternalServerError());
        }

        return sendError(event, statusCode, value);
      }

      event.res.status = statusCode;

      const responseSchema = getResponseSchema(schemas?.response, statusCode);

      if (!responseSchema || !shouldValidateResponse()) {
        return value;
      }

      return await validateResponseSchema(responseSchema, value);
    } catch (error) {
      if (error instanceof RequestValidationFailure) {
        return sendError(event, 422, {
          code: 'VALIDATION_ERROR',
          details: {
            issues: error.issues,
            target: error.target,
          },
          message: 'Request validation failed',
        } satisfies ValidationError);
      }

      if (HTTPError.isError(error)) {
        return sendError(event, error.status, normalizeHTTPError(error));
      }

      return sendError(event, 500, createInternalServerError());
    }
  });

  return eventHandler as TypedRouteHandler<
    TypedHandlerRequest<Schemas>,
    ResolvedSuccess<Schemas, Response>,
    ResolvedErrors<Schemas, Response>
  >;
}

export function status<const Status extends number, const Value>(
  status: Status,
  value: Value,
): StatusResponse<Status, Value> {
  return {
    [statusResponse]: true,
    status,
    value,
  };
}

function getEventQuery(event: H3Event): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};

  for (const [key, value] of event.url.searchParams) {
    const currentValue = query[key];

    if (currentValue === undefined) {
      query[key] = value;
      continue;
    }

    query[key] = Array.isArray(currentValue) ? [...currentValue, value] : [currentValue, value];
  }

  return query;
}

async function readRequestBody(event: H3Event): Promise<unknown> {
  if (!event.req.body) {
    return undefined;
  }

  try {
    return await event.req.json();
  } catch {
    throw new RequestValidationFailure('body', [
      {
        message: 'Request body must contain valid JSON',
      },
    ]);
  }
}

function getResponseSchema(
  response: ResponseSchemas | undefined,
  statusCode: number,
): StandardSchemaV1 | undefined {
  if (!response) {
    return;
  }

  if (isStandardSchema(response)) {
    return statusCode === 200 ? response : undefined;
  }

  return response[statusCode];
}

function isStandardSchema(value: ResponseSchemas): value is StandardSchemaV1 {
  return '~standard' in value;
}

function isStatusResponse(value: unknown): value is StatusResponse {
  return Boolean(value && typeof value === 'object' && statusResponse in value);
}

function shouldValidateResponse(): boolean {
  return useRuntimeConfig().pathstrider?.validation?.response === true;
}

function normalizeHTTPError(error: HTTPError): ErrorShape {
  if (isPathstriderError(error.data)) {
    return error.data;
  }

  if (error.status === 404) {
    return {
      code: 'NOT_FOUND',
      message: error.message || 'Route not found',
    } satisfies NotFoundError;
  }

  return {
    code: 'HTTP_ERROR',
    details: error.data,
    message: error.message || 'HTTP request failed',
  } satisfies HTTPResponseError;
}

function createInternalServerError(): InternalServerError {
  return {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
  };
}

function sendError(event: H3Event, statusCode: number, error: ErrorShape): ErrorShape {
  event.res.status = statusCode;
  event.res.headers.set(errorResponseHeader, '1');

  return error;
}

async function validateRequestSchema<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
  target: ValidationTarget,
): Promise<StandardSchemaV1.InferOutput<Schema>> {
  const result = await schema['~standard'].validate(value);

  if (result.issues) {
    throw new RequestValidationFailure(target, result.issues);
  }

  return result.value;
}

async function validateResponseSchema<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<Schema>> {
  const result = await schema['~standard'].validate(value);

  if (result.issues) {
    throw new Error('Response validation failed');
  }

  return result.value;
}

class RequestValidationFailure extends Error {
  constructor(
    readonly target: ValidationTarget,
    readonly issues: readonly ValidationIssue[],
  ) {
    super('Request validation failed');
  }
}
