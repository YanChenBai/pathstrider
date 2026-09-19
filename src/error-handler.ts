import { defineErrorHandler, type HTTPError } from 'nitro';

import {
  errorResponseHeader,
  type ErrorShape,
  type HTTPResponseError,
  type InternalServerError,
  isPathstriderError,
  type NotFoundError,
} from './error.ts';

export default defineErrorHandler((error, event) => {
  if (event?.req.headers.get('accept')?.includes('text/html')) {
    return;
  }

  const status = error.status || 500;
  const value = normalizeNitroError(error, status);

  return Response.json(value, {
    headers: {
      [errorResponseHeader]: '1',
    },
    status,
  });
});

function normalizeNitroError(error: HTTPError, status: number): ErrorShape {
  if (isPathstriderError(error.data)) {
    return error.data;
  }

  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      message: 'Route not found',
    } satisfies NotFoundError;
  }

  if (status >= 500) {
    return {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    } satisfies InternalServerError;
  }

  return {
    code: 'HTTP_ERROR',
    details: error.data,
    message: error.message || 'HTTP request failed',
  } satisfies HTTPResponseError;
}
