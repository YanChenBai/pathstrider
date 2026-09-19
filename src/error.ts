import type { StandardSchemaV1 } from '@standard-schema/spec';

export interface ErrorShape {
  code: string;
  details?: unknown;
  message: string;
}

export type PathstriderError<Code extends string = string, Details = never> = {
  code: Code;
  message: string;
} & ([Details] extends [never] ? {} : { details: Details });

export type ValidationIssue = StandardSchemaV1.Issue;

export type ValidationTarget = 'body' | 'headers' | 'params' | 'query';

export type ValidationError = PathstriderError<
  'VALIDATION_ERROR',
  {
    issues: readonly ValidationIssue[];
    target: ValidationTarget;
  }
>;

export type InternalServerError = PathstriderError<'INTERNAL_SERVER_ERROR'>;
export type NotFoundError = PathstriderError<'NOT_FOUND'>;
export type HTTPResponseError = PathstriderError<'HTTP_ERROR', unknown>;
export type UnexpectedResponseError = PathstriderError<
  'UNEXPECTED_RESPONSE',
  {
    value: unknown;
  }
>;

export type BuiltInError =
  | HTTPResponseError
  | InternalServerError
  | NotFoundError
  | UnexpectedResponseError
  | ValidationError;

export const errorResponseHeader = 'x-pathstrider-error';

export function isPathstriderError(value: unknown): value is ErrorShape {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const error = value as Record<PropertyKey, unknown>;

  return typeof error.code === 'string' && typeof error.message === 'string';
}
