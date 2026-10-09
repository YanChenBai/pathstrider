import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Nitro, NitroHooks, RollupConfig } from 'nitro/types';
import { expect, test } from 'vite-plus/test';

import { pathstrider } from '../src/vite.ts';

interface SourceMap {
  version: number;
  sources: string[];
  sourcesContent?: string[];
  mappings: string;
}

test('vp pack emits JavaScript and declaration maps for every public entry', async () => {
  for (const entry of ['index', 'client', 'vite']) {
    for (const extension of ['mjs', 'd.mts']) {
      const filename = `${entry}.${extension}`;
      const code = await readFile(new URL(`../dist/${filename}`, import.meta.url), 'utf8');
      expect(code).toContain(`sourceMappingURL=${filename}.map`);
      const map = JSON.parse(
        await readFile(new URL(`../dist/${filename}.map`, import.meta.url), 'utf8'),
      ) as SourceMap;
      expect(map.version).toBe(3);
      expect(map.sources.some(source => source.endsWith('.ts'))).toBe(true);
      expect(map.mappings.length).toBeGreaterThan(0);
      if (extension === 'mjs') {
        expect(map.sourcesContent).toHaveLength(map.sources.length);
        expect(map.sourcesContent?.every(source => source.length > 0)).toBe(true);
      }
    }
  }
});

test('macro mappings retain the original route source when appending metadata', async () => {
  const hooks = new Map<string, unknown>();
  const nitro = {
    options: { alias: {} },
    hooks: { hook: (name: string, handler: unknown) => hooks.set(name, handler) },
  } as unknown as Nitro;
  await pathstrider({ dts: false }).nitro.setup(nitro);
  const config: RollupConfig = {};
  await (hooks.get('rollup:before') as NitroHooks['rollup:before'])(nitro, config);
  const macro = config.plugins![0] as {
    transform: {
      handler: (code: string, id: string) => Promise<{ code: string; map: SourceMap }>;
    };
  };
  const filename = fileURLToPath(new URL('./route.ts', import.meta.url));
  const source = `
    import { z } from 'zod';
    // 原始源码 🐳
    export default defineValidatedHandler({
      responses: { 200: z.string().describe('Success') },
      handler: () => 'hello',
    });
  `;
  const result = await macro.transform.handler(source, `\0nitro:route-meta:${filename}`);
  expect(result.code.startsWith(source)).toBe(true);
  expect(result.code).toContain('defineRouteMeta(');
  expect(result.map.sourcesContent).toEqual([source]);
  expect(result.map.sources).toEqual([filename.replaceAll('\\', '/')]);
  expect(result.map.mappings.length).toBeGreaterThan(0);
});
