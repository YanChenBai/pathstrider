import { defineConfig } from 'vite-plus';

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  pack: {
    deps: { resolveDepSubpath: true },
    dts: {
      generator: 'tsgo',
      sourcemap: true,
    },
    entry: {
      index: './src/index.ts',
      client: './src/client.ts',
      'error-handler': './src/error-handler.ts',
      routes: './src/routes.ts',
      vite: './src/vite.ts',
    },
    exports: true,
    sourcemap: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    singleQuote: true,
    sortImports: true,
    sortTailwindcss: true,
    sortPackageJson: true,
    arrowParens: 'avoid',
    embeddedLanguageFormatting: 'auto',
  },
});
