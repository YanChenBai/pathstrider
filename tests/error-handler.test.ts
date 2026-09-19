import { HTTPError } from 'nitro';
import { describe, expect, test } from 'vite-plus/test';

import errorHandler from '../src/error-handler.ts';

describe('Nitro error fallback', () => {
  test('normalizes unknown server failures without leaking details', async () => {
    const response = await errorHandler(
      new HTTPError({
        message: 'database password leaked',
        status: 500,
      }),
      undefined as never,
      undefined as never,
    );

    expect(response?.status).toBe(500);
    expect(response?.headers.get('x-pathstrider-error')).toBe('1');
    await expect(response?.json()).resolves.toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  });

  test('preserves errors already using the Pathstrider structure', async () => {
    const response = await errorHandler(
      new HTTPError({
        data: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
        status: 401,
      }),
      undefined as never,
      undefined as never,
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  });
});
