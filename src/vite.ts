import { resolve } from 'node:path';

import MagicString from 'magic-string';
import { runtimeDir } from 'nitro/meta';
import type { Nitro, NitroModule } from 'nitro/types';
import type { Plugin } from 'vite';

import { extractContract } from './extract.ts';
import { evaluateContract, generateDeclaration, type ResolvedRoute } from './generator.ts';
import { generateOpenAPI } from './openapi.ts';

export interface PathstriderOptions {
  /** @default 'pathstrider.d.ts' */
  dts?: string | false;
}

export function pathstrider(options: PathstriderOptions = {}): Plugin & { nitro: NitroModule } {
  return {
    name: 'pathstrider',
    nitro: {
      name: 'pathstrider',
      setup(nitro) {
        const generate = async () => {
          if (options.dts === false) return;
          nitro.routing.sync();
          await generateDeclaration({
            dts: resolve(nitro.options.rootDir, options.dts ?? 'pathstrider.d.ts'),
            routes: collectNitroRoutes(nitro),
            aliases: nitro.options.alias,
          });
        };
        nitro.hooks.hook('build:before', generate);
        nitro.hooks.hook('dev:reload', generate);
        nitro.hooks.hook('rollup:before', (_nitro, config) => {
          config.plugins ??= [];
          config.plugins.unshift({
            name: 'pathstrider:macro',
            buildStart: generate,
            transform: {
              order: 'pre',
              async handler(code: string, id: string) {
                const prefix = '\0nitro:route-meta:';
                if (!id.startsWith(prefix)) return;
                const filename = id.slice(prefix.length);
                const source = extractContract(code, filename);
                if (!source) return;
                const contract = await evaluateContract(source, filename, nitro.options.alias);
                const transformed = new MagicString(code);
                transformed.append(
                  `\ndefineRouteMeta(${JSON.stringify({ openAPI: await generateOpenAPI(contract) })});\n`,
                );
                return {
                  code: transformed.toString(),
                  map: transformed.generateMap({
                    hires: true,
                    source: filename,
                    includeContent: true,
                  }),
                };
              },
            },
          });
        });
      },
    },
  };
}

function collectNitroRoutes(nitro: Nitro): ResolvedRoute[] {
  const routes = Object.values(nitro.routing.routes.routes).flatMap(route => route.data);
  const unique = new Map<string, ResolvedRoute>();
  for (const route of routes) {
    const frameworkDirectory = runtimeDir.replaceAll('\\', '/').replace(/\/$/, '') + '/';
    if (
      route.middleware ||
      route.handler.replaceAll('\\', '/').startsWith(frameworkDirectory) ||
      route.handler === nitro.options.renderer?.handler ||
      (nitro.options.serverEntry && route.handler === nitro.options.serverEntry.handler)
    )
      continue;
    unique.set(`${route.method ?? '*'} ${route.route} ${route.handler}`, {
      handler: route.handler,
      method: route.method,
      route: route.route,
    });
  }
  return [...unique.values()];
}
