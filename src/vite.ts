import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Nitro, NitroModule } from 'nitro/types';
import type { Plugin } from 'vite';

import { generateDeclaration, type ResolvedRoute, type RouteFilterOptions } from './generator.ts';

export interface PathstriderOptions {
  output?: {
    /** @default "pathstrider.d.ts" */
    types?: string | false;
  };
  scan?: RouteFilterOptions;
  validation?: {
    /** @default false */
    response?: boolean;
  };
}

export function pathstrider(options: PathstriderOptions = {}): Plugin & { nitro: NitroModule } {
  return {
    name: 'pathstrider',

    nitro: {
      name: 'pathstrider',
      setup(nitro) {
        registerErrorHandler(nitro);
        registerRuntimeConfig(nitro, options);

        nitro.hooks.hook('build:before', async () => {
          if (options.output?.types === false) {
            return;
          }

          nitro.routing.sync();

          const declarationFile = resolveOutput(nitro.options.rootDir, options.output?.types);

          await generateDeclaration({
            clientBaseURL: '/api',
            declarationFile,
            filter: options.scan,
            projectRoot: nitro.options.rootDir,
            routes: collectNitroRoutes(nitro),
          });
        });
      },
    },
  };
}

function registerRuntimeConfig(nitro: Nitro, options: PathstriderOptions): void {
  const current = nitro.options.runtimeConfig.pathstrider ?? {};

  nitro.options.runtimeConfig.pathstrider = {
    ...current,
    validation: {
      ...current.validation,
      response: options.validation?.response ?? false,
    },
  };
}

function registerErrorHandler(nitro: Nitro): void {
  const runtimeExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'mjs';
  const runtimeHandler = fileURLToPath(
    new URL(`./error-handler.${runtimeExtension}`, import.meta.url),
  ).replaceAll('\\', '/');
  const handlers = Array.isArray(nitro.options.errorHandler)
    ? [...nitro.options.errorHandler]
    : [nitro.options.errorHandler];

  if (handlers.includes(runtimeHandler)) {
    return;
  }

  const defaultHandlerIndex = handlers.findIndex(handler =>
    /runtime[\\/]internal[\\/]error/.test(handler),
  );
  const insertionIndex = defaultHandlerIndex === -1 ? handlers.length : defaultHandlerIndex;

  handlers.splice(insertionIndex, 0, runtimeHandler);
  nitro.options.errorHandler = handlers;
}

function collectNitroRoutes(nitro: Nitro): ResolvedRoute[] {
  const routes = Object.values(nitro.routing.routes.routes).flatMap(route => route.data);
  const uniqueRoutes = new Map<string, ResolvedRoute>();

  for (const route of routes) {
    if (route.middleware) {
      continue;
    }

    const key = `${route.method ?? '*'} ${route.route} ${route.handler}`;

    uniqueRoutes.set(key, {
      handler: route.handler,
      method: route.method,
      route: route.route,
    });
  }

  return [...uniqueRoutes.values()];
}

function resolveOutput(root: string, output = 'pathstrider.d.ts'): string {
  return isAbsolute(output) ? output : resolve(root, output);
}
