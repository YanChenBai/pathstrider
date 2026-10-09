import type {
  AnyHTTPMethod,
  TypedFetchInput,
  TypedFetchRequestBody,
  TypedFetchRequestHeaders,
  TypedFetchRequestQuery,
  TypedFetchRequires,
  TypedFetchResponseBody,
  ValidFetchInput,
} from 'fetchdts';
import { ofetch } from 'ofetch';
import type { FetchOptions } from 'ofetch';

export interface Routes {}

export type * from 'fetchdts';

type Field<S, P, M extends AnyHTTPMethod, K extends 'body' | 'query' | 'headers', T> =
  TypedFetchRequires<S, P, M, K> extends true ? { [F in K]: T } : { [F in K]?: T };
type Options<S, P, M extends AnyHTTPMethod> = Omit<
  FetchOptions<'json'>,
  'method' | 'body' | 'query' | 'params' | 'headers' | 'ignoreResponseError'
> &
  Field<S, P, M, 'body', TypedFetchRequestBody<S, P, M>> &
  Field<S, P, M, 'query', TypedFetchRequestQuery<S, P, M>> &
  Field<S, P, M, 'headers', TypedFetchRequestHeaders<S, P, M>> &
  (M extends 'GET' | 'get' ? { method?: M } : { method: M });
type Arguments<S, P, M extends AnyHTTPMethod> =
  {} extends Options<S, P, M> ? [options?: Options<S, P, M>] : [options: Options<S, P, M>];

export interface RouteFetch<S> {
  <const P extends TypedFetchInput<S> & string, M extends AnyHTTPMethod = 'GET'>(
    path: P & ValidFetchInput<S, P, M>,
    ...args: Arguments<S, P, M>
  ): Promise<TypedFetchResponseBody<S, P, M>>;
}

export function createRouteFetch<S = Routes>(
  defaults: Omit<
    FetchOptions<'json'>,
    'method' | 'body' | 'query' | 'params' | 'responseType' | 'ignoreResponseError'
  > = {},
): RouteFetch<S> {
  return ofetch.create(defaults as FetchOptions) as RouteFetch<S>;
}

export const apiFetch = createRouteFetch();
