import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, createNitro } from 'nitro/builder';
import { expect, test } from 'vite-plus/test';

import { pathstrider } from '../src/vite.ts';

test('Nitro integration generates types from its resolved routing table', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pathstrider-nitro-'));
  const apiDirectory = join(directory, 'server', 'api', 'users');

  await mkdir(apiDirectory, { recursive: true });
  await writeFile(
    join(apiDirectory, '[id].get.ts'),
    "export default () => ({ id: 'user-1' });\n",
    'utf8',
  );
  await writeFile(
    join(directory, 'server', 'manual.ts'),
    'export default () => ({ created: true });\n',
    'utf8',
  );
  await writeFile(
    join(directory, 'server', 'api', 'error.get.ts'),
    "export default () => { throw new Error('secret'); };\n",
    'utf8',
  );

  const plugin = pathstrider({
    output: {
      types: './types/pathstrider.d.ts',
    },
    validation: {
      response: true,
    },
  });
  const nitro = await createNitro({
    modules: [plugin.nitro],
    output: {
      dir: join(directory, '.output'),
    },
    preset: 'node-server',
    rootDir: directory,
    routes: {
      '/api/manual': {
        handler: './server/manual.ts',
        method: 'POST',
      },
    },
    serverDir: './server',
  });

  try {
    expect(nitro.options.errorHandler).toEqual(
      expect.arrayContaining([expect.stringMatching(/pathstrider\/src\/error-handler\.ts$/)]),
    );
    expect(nitro.options.runtimeConfig.pathstrider).toEqual({
      validation: {
        response: true,
      },
    });

    await build(nitro);

    const source = await readFile(join(directory, 'types', 'pathstrider.d.ts'), 'utf8');

    expect(source).toContain('(params: { id: string }): {');
    expect(source).toContain(
      `get: Route<typeof import("../server/api/users/[id].get").default, 'GET'>;`,
    );
    expect(source).toContain(`post: Route<typeof import("../server/manual").default, 'POST'>;`);
  } finally {
    await nitro.close();

    if (directory.startsWith(tmpdir())) {
      await rm(directory, { force: true, recursive: true });
    }
  }
});
