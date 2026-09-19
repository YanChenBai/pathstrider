import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vite-plus/test';

import {
  createRouteEntries,
  generateDeclaration,
  renderDeclaration,
  type GenerateDeclarationOptions,
} from '../src/generator.ts';

const projectRoot = 'C:\\project';
const declarationFile = 'C:\\project\\pathstrider.d.ts';

function createOptions(
  routes: GenerateDeclarationOptions['routes'],
  overrides: Partial<GenerateDeclarationOptions> = {},
): GenerateDeclarationOptions {
  return {
    clientBaseURL: '/api',
    declarationFile,
    projectRoot,
    routes,
    ...overrides,
  };
}

describe('route generation', () => {
  test('uses the client base URL as the default Nitro route filter', () => {
    const entries = createRouteEntries(
      createOptions([
        { handler: 'server/api/users.get.ts', method: 'GET', route: '/api/users' },
        { handler: 'server/routes/page.ts', method: 'GET', route: '/page' },
      ]),
    );

    expect(entries).toEqual([
      expect.objectContaining({
        file: 'server/api/users.get.ts',
        method: 'GET',
        route: '/users',
      }),
    ]);
  });

  test('supports include, exclude, and method filters', () => {
    const entries = createRouteEntries(
      createOptions(
        [
          { handler: 'public.get.ts', method: 'GET', route: '/api/public/users' },
          { handler: 'public.post.ts', method: 'POST', route: '/api/public/users' },
          { handler: 'private.get.ts', method: 'GET', route: '/api/private/users' },
        ],
        {
          filter: {
            exclude: ['/api/public/private/**'],
            include: ['/api/public/**'],
            methods: ['GET'],
          },
        },
      ),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.file).toBe('public.get.ts');
  });

  test('double-star filters also match the route prefix itself', () => {
    const entries = createRouteEntries(
      createOptions(
        [
          { handler: 'internal.ts', method: 'GET', route: '/api/internal' },
          { handler: 'public.ts', method: 'GET', route: '/api/public' },
        ],
        {
          filter: {
            exclude: ['/api/internal/**'],
            include: ['/api/**'],
          },
        },
      ),
    );

    expect(entries.map(route => route.file)).toEqual(['public.ts']);
  });

  test('expands method-agnostic Nitro handlers to every supported method', () => {
    const entries = createRouteEntries(
      createOptions([{ handler: 'server/api/index.ts', route: '/api' }]),
    );

    expect(entries.map(route => route.method)).toEqual([
      'CONNECT',
      'DELETE',
      'GET',
      'HEAD',
      'OPTIONS',
      'PATCH',
      'POST',
      'PUT',
      'QUERY',
      'TRACE',
    ]);
    expect(entries.every(route => route.route === '/')).toBe(true);
  });

  test('accepts absolute base URLs', () => {
    const entries = createRouteEntries(
      createOptions([{ handler: 'users.ts', method: 'GET', route: '/v1/users' }], {
        clientBaseURL: 'https://example.test/v1/',
      }),
    );

    expect(entries[0]?.route).toBe('/users');
  });

  test('renders static, dynamic, catch-all, and query routes', () => {
    const entries = createRouteEntries(
      createOptions([
        { handler: 'server/api/index.get.ts', method: 'GET', route: '/api' },
        { handler: 'server/api/users/[id].get.ts', method: 'GET', route: '/api/users/:id' },
        {
          handler: 'server/api/files/[...path].query.ts',
          method: 'QUERY',
          route: '/api/files/**:path',
        },
      ]),
    );
    const source = renderDeclaration(declarationFile, projectRoot, entries);

    expect(source).toContain('InferHandlerErrors<Handler>');
    expect(source).toContain(
      'get: Route<typeof import("./server/api/index.get").default, \'GET\'>;',
    );
    expect(source).toContain('(params: { id: string }): {');
    expect(source).toContain('(params: { path: string | string[] }): {');
    expect(source).toContain(
      'query: Route<typeof import("./server/api/files/[...path].query").default, \'QUERY\'>;',
    );
  });

  test('prefers method-specific handlers over method-agnostic fallbacks', () => {
    const entries = createRouteEntries(
      createOptions([
        { handler: 'fallback.ts', route: '/api/users' },
        { handler: 'get.ts', method: 'GET', route: '/api/users' },
      ]),
    );
    const source = renderDeclaration(declarationFile, projectRoot, entries);

    expect(source).toContain(`get: Route<typeof import("./get").default, 'GET'>;`);
    expect(source).not.toContain(`get: Route<typeof import("./fallback").default, 'GET'>;`);
    expect(source).toContain(`post: Route<typeof import("./fallback").default, 'POST'>;`);
  });

  test('rejects ambiguous dynamic route shapes', () => {
    const entries = createRouteEntries(
      createOptions([
        { handler: 'id.ts', method: 'GET', route: '/api/users/:id' },
        { handler: 'name.ts', method: 'POST', route: '/api/users/:name' },
      ]),
    );

    expect(() => renderDeclaration(declarationFile, projectRoot, entries)).toThrow(
      'Conflicting dynamic routes',
    );
  });

  test('rejects unsupported methods', () => {
    expect(() =>
      createRouteEntries(
        createOptions([{ handler: 'custom.ts', method: 'CUSTOM', route: '/api/custom' }]),
      ),
    ).toThrow('Unsupported HTTP method');
  });
});

test('generateDeclaration skips unchanged output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pathstrider-'));
  const output = join(directory, 'types', 'routes.d.ts');
  const options = createOptions(
    [{ handler: join(directory, 'server', 'api', 'index.get.ts'), method: 'GET', route: '/api' }],
    {
      declarationFile: output,
      projectRoot: directory,
    },
  );

  await expect(generateDeclaration(options)).resolves.toBe(true);
  await expect(generateDeclaration(options)).resolves.toBe(false);
  await expect(readFile(output, 'utf8')).resolves.toContain("declare module 'pathstrider/routes'");
});
