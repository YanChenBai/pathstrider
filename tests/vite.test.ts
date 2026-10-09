import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { nitro } from 'nitro/vite';
import type { OpenAPIV3 } from 'openapi-types';
import { createServer, type InlineConfig, type PluginOption } from 'vite-native';
import { expect, test } from 'vite-plus/test';

import { pathstrider } from '../src/vite.ts';

const execute = promisify(execFile);
const temporaryRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url));

test('runs as a standard Vite plugin and emits usable public route types', async () => {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'vite-'));
  await mkdir(join(directory, 'server/api'), { recursive: true });
  await writeFile(join(directory, 'index.html'), '<html><body>Pathstrider</body></html>');
  await writeFile(
    join(directory, 'server/api/greeting.get.ts'),
    `
    import { defineValidatedHandler } from 'pathstrider';
    import { z } from 'zod';
    export default defineValidatedHandler({
      validate: { query: z.object({ name: z.string().describe('User name') }) },
      responses: { 200: z.object({ name: z.string() }).describe('Successful greeting') },
      openAPI: { tags: ['greeting'], description: 'Returns a greeting' },
      handler: ({ query }) => ({ name: query.name }),
    });
  `,
  );
  const config: InlineConfig = {
    configFile: false,
    root: directory,
    logLevel: 'silent',
    plugins: [
      nitro({ rootDir: directory, serverDir: './server', experimental: { openAPI: true } }),
      pathstrider({ dts: './.types/routes.d.ts' }),
    ] as unknown as PluginOption[],
    server: { host: '127.0.0.1', port: 0 },
  };
  const server = await createServer(config);
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite port');
    const baseURL = `http://127.0.0.1:${address.port}`;
    expect(
      await fetch(`${baseURL}/api/greeting?name=Codex`).then(response => response.json()),
    ).toEqual({ name: 'Codex' });
    const invalid = await fetch(`${baseURL}/api/greeting`);
    expect(invalid.status).toBe(400);
    const openAPI = (await fetch(`${baseURL}/_openapi.json`).then(response =>
      response.json(),
    )) as OpenAPIV3.Document;
    expect(openAPI.paths['/api/greeting']!.get).toMatchObject({
      tags: ['greeting'],
      parameters: [{ name: 'name', in: 'query', required: true, description: 'User name' }],
      responses: {
        200: {
          description: 'Successful greeting',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    });
    const declaration = await readFile(join(directory, '.types/routes.d.ts'), 'utf8');
    expect(declaration).toContain("declare module 'pathstrider/client'");
    expect(declaration).not.toContain('vite-plus');
    await writeFile(
      join(directory, 'client.ts'),
      `
      import { apiFetch } from 'pathstrider/client';
      const greeting = await apiFetch('/api/greeting', { query: { name: 'Codex' } });
      const name: string = greeting.name;
      // @ts-expect-error query is required
      await apiFetch('/api/greeting');
      // @ts-expect-error wrong query type
      await apiFetch('/api/greeting', { query: { name: 42 } });
      // @ts-expect-error unknown route
      await apiFetch('/missing');
      // @ts-expect-error unregistered method
      await apiFetch('/api/greeting', { method: 'POST', query: { name } });
      // @ts-expect-error response has no id
      const id = greeting.id;
    `,
    );
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['./client.ts', './server/**/*.ts', './.types/**/*.d.ts'],
      }),
    );
    const compiler = join(
      dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))),
      'bin/tsc',
    );
    await execute(process.execPath, [compiler, '-p', join(directory, 'tsconfig.json')], {
      timeout: 30000,
    }).catch((error: Error & { stdout: string; stderr: string }) => {
      throw new Error(`${error.stdout}\n${error.stderr}`, { cause: error });
    });
  } finally {
    await server.close();
    if (resolve(directory).startsWith(resolve(temporaryRoot) + sep)) {
      await rm(directory, { force: true, recursive: true });
    }
  }
}, 60000);
