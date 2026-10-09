import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { generateDeclaration } from '../src/generator.ts';

test('generates fetchdts routes, method matching and public package imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pathstrider-generator-'));
  const dts = join(directory, 'routes.d.ts');
  const handler = fileURLToPath(new URL('./fixtures/greeting.ts', import.meta.url));
  const options = {
    dts,
    routes: [
      { route: '/users/:id', method: 'POST', handler },
      { route: '/files/**', method: 'GET', handler },
      { route: '/any', handler },
    ],
  };
  try {
    expect(await generateDeclaration(options)).toBe(true);
    expect(await generateDeclaration(options)).toBe(false);
    const source = await readFile(dts, 'utf8');
    expect(source).toContain('[DynamicParam]');
    expect(source).toContain('[WildcardParam]');
    expect(source).toContain('"POST"');
    expect(source).toContain('Record<HTTPMethod');
    expect(source).toContain("from 'pathstrider/client'");
    expect(source).toContain("declare module 'pathstrider/client'");
    expect(source).toContain('OptionalRequestOf<typeof Handler0');
    expect(source).not.toContain('@ts-nocheck');
    expect(source).not.toContain('vite-plus');
  } finally {
    if (directory.startsWith(join(tmpdir(), 'pathstrider-generator-')))
      await rm(directory, { recursive: true, force: true });
  }
});
