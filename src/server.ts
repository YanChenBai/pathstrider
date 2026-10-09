import type { StandardSchemaV1, StandardTypedV1 } from '@standard-schema/spec';
import { defineHandler, getQuery, readBody, HTTPError } from 'nitro/h3';
import type {
  H3Event,
  EventHandlerResponse,
  defineValidatedHandler as NativeHandler,
} from 'nitro/h3';
import type { OpenAPIV3 } from 'openapi-types';

export type Field = 'body' | 'headers' | 'query';
export type Validation = Partial<Record<Field, StandardSchemaV1>> & {
  onError?: NonNullable<Parameters<typeof NativeHandler>[0]['validate']>['onError'];
};
export type Responses = Partial<Record<number, StandardTypedV1>>;
export type RouteOpenAPI = Omit<OpenAPIV3.OperationObject, 'responses'> & { responses?: never };
export interface RouteContract {
  validate?: Validation;
  responses?: Responses;
  openAPI?: RouteOpenAPI;
}
export type Validated<V extends Validation> = {
  [K in Extract<keyof V, Field>]: V[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<V[K]>
    : never;
};

declare const contract: unique symbol;
export type ValidatedRouteHandler<V extends Validation, S extends Responses> = ReturnType<
  typeof defineHandler
> & {
  [contract]: { validate: V; responses: S };
};
type ContractOf<T> = T extends { [contract]: infer C } ? C : never;
export type RequestOf<T, K extends Field> =
  ContractOf<T> extends { validate: infer V }
    ? K extends keyof V
      ? V[K] extends StandardSchemaV1
        ? StandardSchemaV1.InferInput<V[K]>
        : unknown
      : unknown
    : unknown;
export type OptionalRequestOf<T, K extends Field> =
  {} extends RequestOf<T, K> ? RequestOf<T, K> | undefined : RequestOf<T, K>;
export type ResponseOf<T> =
  ContractOf<T> extends { responses: infer R }
    ? {
        [K in keyof R]: `${K & (string | number)}` extends `2${string}`
          ? R[K] extends StandardTypedV1
            ? StandardTypedV1.InferOutput<R[K]>
            : never
          : never;
      }[keyof R]
    : unknown;

export function defineValidatedHandler<
  const V extends Validation = {},
  const S extends Responses = {},
  R extends EventHandlerResponse = EventHandlerResponse,
>(options: {
  validate?: V & Validation;
  responses?: S;
  openAPI?: RouteOpenAPI;
  handler: (validated: Validated<V>, event: H3Event) => R;
}): ValidatedRouteHandler<V, S> {
  const handler = defineHandler(async event => {
    const validated: Record<string, unknown> = Object.create(null);

    for (const source of ['query', 'headers', 'body'] as const) {
      const schema = options.validate?.[source];
      if (!schema) continue;

      const input =
        source === 'body'
          ? await readBody(event)
          : source === 'query'
            ? getQuery(event)
            : Object.fromEntries(event.req.headers);

      // 保留 schema 输出，避免 H3 将转换后的 query/header 再序列化为字符串。
      const result = await schema['~standard'].validate(input);
      if (result.issues) {
        const details = options.validate?.onError?.({ ...result, _source: source });
        if (HTTPError.isError(details)) throw details;
        const custom = details instanceof Error ? undefined : details;
        throw new HTTPError({
          status: custom?.status ?? 400,
          statusText: custom?.statusText,
          message: details?.message ?? 'Validation failed',
          cause: details,
          data: { issues: result.issues },
        });
      }
      validated[source] = result.value;
    }

    return await options.handler(validated as Validated<V>, event);
  });

  return handler as ValidatedRouteHandler<V, S>;
}
