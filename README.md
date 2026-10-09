# Pathstrider

Validated Nitro routes, automatic OpenAPI schemas, and typed ofetch clients. A Vite plugin built on Vite's OXC parser and fetchdts.

## Install

```sh
pnpm add pathstrider zod
```

Requires Vite 8.3+ and Nitro 3. Pathstrider imports `parseSync` and `Visitor` directly from `vite`; applications do not need Vite+ or a separate OXC parser.

## Vite plugin

```ts
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { pathstrider } from 'pathstrider/vite';

export default defineConfig({
  plugins: [
    nitro({ experimental: { openAPI: true } }),
    pathstrider({ dts: './.types/pathstrider.d.ts' }),
  ],
});
```

`dts` defaults to `pathstrider.d.ts`. Set `dts: false` to disable route declarations while keeping OpenAPI generation. Include the generated declaration in your application's tsconfig and start Vite or build before checking client types.

The plugin follows Nitro's resolved routing table, including configured routes. Static, dynamic, wildcard, and method-specific routes are compiled with fetchdts. Paths remain absolute, including `/api`; no implicit prefix is stripped.

## Route

```ts
import { defineValidatedHandler } from 'pathstrider';
import { z } from 'zod';

export default defineValidatedHandler({
  validate: {
    query: z.object({ name: z.string().describe('User name') }),
  },
  responses: {
    200: z.object({ name: z.string() }).describe('Successful greeting'),
  },
  openAPI: {
    tags: ['greeting'],
    description: 'Returns a greeting message',
  },
  handler: ({ query }, event) => ({ name: query.name }),
});
```

Request validation supports `query`, `headers`, and JSON `body`. The first handler argument contains the schemas' parsed outputs; the second is the H3 event. Async validation, defaults and transforms are supported. Invalid requests return HTTP 400. Customize this through `validate.onError`.

`responses` maps status codes directly to schemas. The schema's top-level description becomes the OpenAPI response description. `openAPI` supplies operation metadata and parameter overrides; it does not accept `responses`. Response schemas describe documentation and client types; they do not validate or transform returned values at runtime.

Runtime validation accepts Standard Schema implementations. OpenAPI conversion uses Standard JSON Schema's `~standard.jsonSchema.input/output` with the `openapi-3.0` target. Choose a schema library that implements both standards; Zod is only used in the example. Missing or unsupported conversions fail the build. Request JSON schemas use the input representation, response JSON schemas use the output representation.

The build macro supports a default exported `defineValidatedHandler(...)` call, named import aliases, inline schemas, local const declarations, and imported schemas. Top-level option spreads and computed keys are rejected. Business handler code and unrelated route-level statements are excluded from schema evaluation. Imported schema modules should have no business side effects.

OpenAPI is available at `/_openapi.json` during development. Production availability is controlled by Nitro's `openAPI.production` setting.

## Client

```ts
import { apiFetch, createRouteFetch } from 'pathstrider/client';

const greeting = await apiFetch('/api/greeting', {
  query: { name: 'Codex' },
});
greeting.name; // string

const api = createRouteFetch({ baseURL: 'https://example.com' });
```

The generated declarations augment the client's `Routes` interface. Routes, HTTP methods, required query/body/headers, and successful responses are inferred. Request types use schema inputs; response types use the union of declared 2xx schema outputs. Ordinary Nitro handlers remain callable with unknown response types.

This is an ofetch client: failed HTTP responses throw ofetch's `FetchError`, and declared bodies are sent as JSON. Route calls use JSON response mode. Use ofetch directly for other response formats or arbitrary URLs.

## Breaking migration

The former `defineTypedHandler`, `status`, Ky `useClient`, tree-shaped routes and custom error-handler exports have been removed. Use `defineValidatedHandler({ validate, responses, openAPI, handler })`, `apiFetch('/path', options)` and the Vite plugin's `dts` option. Regenerate route declarations rather than editing old generated files.

## Development

```sh
vp install
vp pack
vp check
vp test run
```

Development checks use Vite+; the published plugin imports standard Vite. `vp pack` reads the package build settings from `vite.config.ts` and emits JavaScript and declaration sourcemaps. The macro also returns a sourcemap with the original route source embedded.
