import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';

import { compileRoutes } from 'fetchdts/compiler';
import type { Route } from 'fetchdts/compiler';
import { createJiti } from 'jiti';
import { routeNodeKeys } from 'rou3';

import { extractContract } from './extract.ts';
import { generateOpenAPI } from './openapi.ts';
import type { RouteContract } from './server.ts';

export interface ResolvedRoute {
  handler: string;
  method?: string;
  route: string;
}

export interface GenerateDeclarationOptions {
  dts: string;
  routes: ResolvedRoute[];
  aliases?: Record<string, string>;
}

export async function evaluateContract(
  source: string,
  filename: string,
  aliases: Record<string, string> = {},
): Promise<RouteContract> {
  const jiti = createJiti(filename, { moduleCache: false, fsCache: false, alias: aliases });
  const evaluated = await jiti.evalModule(source, { filename, async: true });
  if (!evaluated || typeof evaluated !== 'object' || !('default' in evaluated)) {
    throw new Error(`${filename}: failed to evaluate route contract`);
  }
  return evaluated.default as RouteContract;
}

export async function generateDeclaration(options: GenerateDeclarationOptions): Promise<boolean> {
  const routes: Route[] = [];
  const imports = ["import type { OptionalRequestOf, ResponseOf } from 'pathstrider';"];
  let index = 0;
  for (const handler of options.routes) {
    const file = await readHandler(handler.handler);
    const source = file && extractContract(file.code, file.filename);
    const metadata: Record<string, string> = {};
    if (source) {
      const contract = await evaluateContract(source, file!.filename, options.aliases);
      await generateOpenAPI(contract);
      const name = `Handler${index++}`;
      imports.push(
        `import type ${name} from ${JSON.stringify(importPath(options.dts, file!.filename))};`,
      );
      for (const field of ['query', 'body', 'headers'] as const) {
        if (contract.validate?.[field])
          metadata[`${field}Type`] = `OptionalRequestOf<typeof ${name}, '${field}'>`;
      }
      if (contract.responses && Object.keys(contract.responses).length) {
        metadata.responseType = `ResponseOf<typeof ${name}>`;
      }
    }
    for (const key of routeNodeKeys(handler.route)) {
      routes.push({
        segments: key
          .split('/')
          .slice(1)
          .map(segment => {
            if (segment === '*') return { type: 'dynamic' as const };
            if (segment === '**') return { type: 'wildcard' as const };
            return segment.replace(/\\(.)/g, '$1');
          }),
        metadata: { [handler.method?.toUpperCase() ?? 'ALL']: metadata },
      });
    }
  }
  const compiled = compileRoutes([{ routes }], {
    name: 'ServerRoutes',
    imports,
    moduleSpecifier: 'pathstrider/client',
  });
  const source = `${compiled.code}\n\ndeclare module 'pathstrider/client' {\n  interface Routes extends ServerRoutes {}\n}\n`;
  const current = await readFile(options.dts, 'utf8').catch(() => '');
  if (current === source) return false;
  await mkdir(dirname(options.dts), { recursive: true });
  await writeFile(options.dts, source, 'utf8');
  return true;
}

function importPath(from: string, to: string): string {
  const path = relative(dirname(from), to)
    .replaceAll('\\', '/')
    .replace(/\.mts$/, '.mjs')
    .replace(/\.cts$/, '.cjs')
    .replace(/\.tsx?$/, '.js');
  return path.startsWith('.') ? path : `./${path}`;
}

async function readHandler(
  filename: string,
): Promise<{ filename: string; code: string } | undefined> {
  if (!isAbsolute(filename)) return;
  for (const extension of ['', '.mjs', '.js', '.ts', '.mts', '.tsx', '.jsx']) {
    const path = filename + extension;
    try {
      return { filename: path, code: await readFile(path, 'utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
