import ky, { type KyInstance, type Options } from 'ky';
import type { EventHandlerRequest, EventHandlerWithFetch, H3Event } from 'nitro';

import { type ErrorShape, isPathstriderError, type UnexpectedResponseError } from './error.ts';
import { httpMethods, type HTTPMethod, type UppercaseHTTPMethod } from './http.ts';
import type { AppRoutes } from './routes.ts';

export { httpMethods } from './http.ts';
export type { HTTPMethod, UppercaseHTTPMethod } from './http.ts';

type RequestBody<Request> = Request extends { body: infer Body } ? Body : unknown;
type RequestHeaders = NonNullable<Options['headers']>;

export type InferHandlerRequest<Handler> = Handler extends {
  readonly __pathstrider: { request: infer Request };
}
  ? Request
  : Handler extends EventHandlerWithFetch<infer Request, infer _Response>
    ? Request
    : Handler extends (event: H3Event<infer Request>) => unknown
      ? Request
      : EventHandlerRequest;

export type InferHandlerResponse<Handler> = Handler extends {
  readonly __pathstrider: { response: infer Response };
}
  ? Response
  : Handler extends EventHandlerWithFetch<infer _Request, infer Response>
    ? Awaited<Response>
    : Handler extends (...arguments_: never[]) => infer Response
      ? Awaited<Response>
      : unknown;

export type InferHandlerErrors<Handler> = Handler extends {
  readonly __pathstrider: { errors: infer Errors };
}
  ? Errors
  : ClientError<number, ErrorShape>;

export type ClientResult<Data, Errors = ClientError<number, ErrorShape>> =
  | {
      data: Data;
      error: null;
      response: Response;
      status: number;
    }
  | {
      data: null;
      error: Errors;
      response: Response;
      status: number;
    };

export interface ClientError<
  Status extends number = number,
  Value extends ErrorShape = ErrorShape,
> {
  status: Status;
  value: Value;
}

export namespace Client {
  export type Error<Method> = Method extends (
    ...arguments_: never[]
  ) => Promise<ClientResult<unknown, infer Errors>>
    ? Errors extends ClientError<infer Status, infer Value>
      ? ClientHTTPError<Status, Value>
      : never
    : never;
}

export class ClientHTTPError<
  Status extends number = number,
  Value extends ErrorShape = ErrorShape,
> extends Error {
  readonly status: Status;
  readonly value: Value;

  constructor(
    readonly request: Request,
    readonly response: Response,
    error: ClientError<Status, Value>,
  ) {
    super(`${error.status}: ${error.value.message}`);

    this.name = 'ClientHTTPError';
    this.status = error.status;
    this.value = error.value;
  }
}

export interface ClientRequestOptions<Request> {
  query?: Request extends { query: infer Query } ? Query : never;
  headers?: Request extends { headers: infer Headers } ? RequestHeaders & Headers : RequestHeaders;
  fetch?: Omit<
    Options,
    'body' | 'headers' | 'json' | 'method' | 'searchParams' | 'throwHttpErrors'
  >;
}

export type ClientMethod<
  Request,
  Response,
  Method extends UppercaseHTTPMethod,
  Errors = ClientError<number, ErrorShape>,
> = Method extends 'GET' | 'HEAD'
  ? (options?: ClientRequestOptions<Request>) => Promise<ClientResult<Response, Errors>>
  : unknown extends RequestBody<Request>
    ? (
        body?: RequestBody<Request>,
        options?: ClientRequestOptions<Request>,
      ) => Promise<ClientResult<Response, Errors>>
    : (
        body: RequestBody<Request>,
        options?: ClientRequestOptions<Request>,
      ) => Promise<ClientResult<Response, Errors>>;

export interface ClientResponseContext {
  response: Response;
  value: unknown;
}

export interface ClientResponseErrorContext extends ClientResponseContext {
  error: ClientError;
}

export interface ClientRequestErrorContext {
  error: unknown;
  request: Request;
}

export interface PathstriderHooks {
  onRequestError?: (context: ClientRequestErrorContext) => Promise<void> | void;
  onResponse?: (context: ClientResponseContext) => Promise<void> | void;
  onResponseError?: (context: ClientResponseErrorContext) => Promise<void> | void;
}

export interface ClientOptions extends Omit<
  Options,
  'body' | 'json' | 'method' | 'searchParams' | 'throwHttpErrors'
> {
  pathstriderHooks?: PathstriderHooks;
  throwHttpErrors?: Options['throwHttpErrors'];
}

interface ProxyContext {
  baseUrl: URL | string;
  hooks?: PathstriderHooks;
  segments: string[];
  throwHttpErrors: NonNullable<ClientOptions['throwHttpErrors']>;
  instance: KyInstance;
}

const httpMethodSet = new Set<string>(httpMethods);

export function useClient<Routes = AppRoutes>(options: ClientOptions = {}): Routes {
  const { baseUrl = '/api/', pathstriderHooks, throwHttpErrors = true, ...kyOptions } = options;

  return createRouteProxy({
    baseUrl,
    hooks: pathstriderHooks,
    segments: [],
    throwHttpErrors,
    instance: ky.create({
      ...kyOptions,
      baseUrl,
    }),
  }) as Routes;
}

export function isClientHTTPError<Error extends ClientHTTPError = ClientHTTPError>(
  error: unknown,
): error is Error {
  return error instanceof ClientHTTPError;
}

function createRouteProxy(context: ProxyContext): unknown {
  return new Proxy(() => undefined, {
    get(_, property) {
      if (property === 'then' || typeof property !== 'string') {
        return undefined;
      }

      if (isHTTPMethod(property)) {
        return createRequest(context, property);
      }

      return createRouteProxy({
        ...context,
        segments: [...context.segments, property],
      });
    },

    apply(_, __, argumentsList: [Record<string, string | string[]>]) {
      const [params] = argumentsList;
      const values = Object.values(params).flat();

      return createRouteProxy({
        ...context,
        segments: [...context.segments, ...values],
      });
    },
  });
}

function createRequest(context: ProxyContext, method: HTTPMethod) {
  return async (
    bodyOrOptions?: unknown,
    requestOptions?: ClientRequestOptions<EventHandlerRequest>,
  ): Promise<ClientResult<unknown>> => {
    const hasBody = method !== 'get' && method !== 'head';
    const body = hasBody ? bodyOrOptions : undefined;
    const options = hasBody
      ? requestOptions
      : (bodyOrOptions as ClientRequestOptions<EventHandlerRequest> | undefined);

    const path = context.segments.map(encodeURIComponent).join('/');
    const searchParams = createSearchParams(options?.query);
    const requestURL = appendSearchParams(resolveRequestURL(path, context.baseUrl), searchParams);
    const request = new Request(requestURL, {
      headers: options?.headers as RequestInit['headers'],
      method: method.toUpperCase(),
    });

    let response: Response;

    try {
      const fetchOptions: Options = {
        ...options?.fetch,
        json: body,
        method,
        searchParams,
        throwHttpErrors: false,
      };

      if (options?.headers !== undefined) {
        fetchOptions.headers = options.headers;
      }

      response = await context.instance(path, fetchOptions);
    } catch (error) {
      await context.hooks?.onRequestError?.({ error, request });

      throw error;
    }

    const value = await readResponseBody(response.clone());

    await context.hooks?.onResponse?.({ response, value });

    if (!response.ok) {
      const error: ClientError = {
        status: response.status,
        value: normalizeResponseError(value),
      };

      await context.hooks?.onResponseError?.({ error, response, value });

      if (shouldThrowHTTPError(context.throwHttpErrors, response.status)) {
        throw new ClientHTTPError(request, response, error);
      }

      return {
        data: null,
        error,
        response,
        status: response.status,
      };
    }

    return {
      data: value,
      error: null,
      response,
      status: response.status,
    };
  };
}

function createSearchParams(query: unknown): Options['searchParams'] {
  if (!query || typeof query !== 'object' || query instanceof URLSearchParams) {
    return query as Options['searchParams'];
  }

  const searchParams = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const value of values) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
  }

  return searchParams;
}

function appendSearchParams(url: string, searchParams: Options['searchParams']): string {
  if (!searchParams) {
    return url;
  }

  const resolvedURL = new URL(url, 'http://pathstrider.local');
  resolvedURL.search = new URLSearchParams(
    searchParams as ConstructorParameters<typeof URLSearchParams>[0],
  ).toString();

  return /^https?:\/\//.test(url)
    ? resolvedURL.href
    : `${resolvedURL.pathname}${resolvedURL.search}`;
}

function isHTTPMethod(value: string): value is HTTPMethod {
  return httpMethodSet.has(value);
}

function resolveRequestURL(path: string, baseUrl: URL | string): string {
  const location = Reflect.get(globalThis, 'location') as { origin?: unknown } | undefined;
  const origin =
    typeof location?.origin === 'string' ? location.origin : 'http://pathstrider.local';
  const resolvedBaseUrl = new URL(baseUrl, origin);

  return new URL(path, resolvedBaseUrl).href;
}

function normalizeResponseError(value: unknown): ErrorShape {
  if (isPathstriderError(value)) {
    return value;
  }

  return {
    code: 'UNEXPECTED_RESPONSE',
    details: { value },
    message: 'Received an unexpected error response',
  } satisfies UnexpectedResponseError;
}

function shouldThrowHTTPError(
  option: NonNullable<ClientOptions['throwHttpErrors']>,
  status: number,
): boolean {
  return typeof option === 'function' ? option(status) : option;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }

  const text = await response.text();

  if (!text) {
    return undefined;
  }

  const contentType = response.headers.get('content-type');

  if (!contentType?.includes('json')) {
    return text;
  }

  return JSON.parse(text) as unknown;
}
