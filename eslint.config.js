// CortexOS — root ESLint flat config (ESLint 9.x)
//
// Boring tech, one source of truth, no snowflakes.
//
// Stack:
//   - ESLint 9.39.4
//   - eslint-config-airbnb-extended 3.1.0  (NOT the stale canonical airbnb)
//   - typescript-eslint 8.60.1
//   - @eslint/js 9.39.4
//   - globals 17.6.0
//
// IMPORTANT — the airbnb-extended import path is `configs.base.recommended`.
// The M0-D tech-stack v0.1 example had a one-liner bug
// (`airbnbExt.configs.recommended` — does not exist). This is the correct
// path: `airbnbExtConfigs.base.recommended`. The Node preset lives at
// `airbnbExtConfigs.node.recommended`. The values are ARRAYS of config
// blocks — they must be spread (`...airbnbExtConfigs.base.recommended`).
//
// Per-package overrides are expressed via `files` globs. Workspace-internal
// libs each get their own rule strictness:
//
//   packages/cortex-audit/**        → strict, node + base
//   packages/cortex-mail-guardian/**→ strict, node + base
//   packages/cortex-telemetry/**    → strict, node + base
//   packages/contracts/**           → strictest (zero-tolerance, no console)
//   packages/design-tokens/**       → strictest
//   packages/dashboard-next/**      → react-aware (React 19 + TanStack Start)

import js from '@eslint/js';
import ts from 'typescript-eslint';
import { configs as airbnbExtConfigs } from 'eslint-config-airbnb-extended';
import importX from 'eslint-plugin-import-x';
import stylistic from '@stylistic/eslint-plugin';
import n from 'eslint-plugin-n';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const SRC_GLOBS = ['**/*.{js,jsx,mjs,cjs,ts,tsx}'];

// Files ESLint should never look at (per-package, framework build outputs, deps)
const IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/out/**',
  '**/coverage/**',
  '**/.turbo/**',
  '**/.wrangler/**',
  '**/.output/**',
  '**/.tanstack/**',
  '**/*.min.js',
  '**/pnpm-lock.yaml',
  // untracked vendored/host-local content, first-party scope per MP-015
  'hermes/**',
  'hermes-webui/**',
  'stacks/**',
  'scripts/**',
  'templates/**',
];

export default [
  // 1) Global ignores
  {
    ignores: IGNORE,
  },

  // 2) JS recommended baseline
  js.configs.recommended,

  // 3) TypeScript recommended (no type-checked — see §1 note at the bottom)
  ...ts.configs.recommended,

  // 4) Airbnb base + Node presets
  //    The Node preset adds n/* rules (camelcase, no-process-env, etc.)
  //    which we want for the backend libs but want off for the SvelteKit
  //    app (browser env). Per-package overrides handle that.
  ...airbnbExtConfigs.base.recommended,
  ...airbnbExtConfigs.base.typescript,
  ...airbnbExtConfigs.node.recommended,

  // 5) Common rule deviations (applied to everything that doesn't override)
  {
    files: SRC_GLOBS,
    // The airbnb-extended config block rules are scoped to their own
    // `files` glob. When we override rules here, we need the plugins
    // registered in the SAME config object so the override can resolve
    // them. Register import-x and @stylistic globally.
    plugins: {
      'import-x': importX,
      '@stylistic': stylistic,
      n,
      '@typescript-eslint': ts.plugin,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parser: ts.parser,
      // parserOptions are inherited from airbnb-extended (which sets
      // projectService: true for .ts files). Don't override here.
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      // ---- Airbnb rules we deliberately TURN OFF (with reason) ----
      // NOTE: airbnb-extended uses `import-x/*` (eslint-plugin-import-x
      // fork), not the canonical `import/*` from eslint-plugin-import.
      // import-x/no-unresolved: false positives for TS path aliases; typescript-eslint handles it
      'import-x/no-unresolved': 'off',
      // import-x/extensions: off — Vite/TS handle extensions; linting them is noise.
      // Also false positives for TS path-alias imports (no TS resolver configured
      // for import-x — same rationale as no-unresolved above).
      'import-x/extensions': 'off',
      // no-console: apps and CLIs legitimately log; per-package override for libs
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      // no-underscore-dangle: we use _id, _count for unused-discard pattern
      'no-underscore-dangle': ['error', { allowAfterThis: true, allow: ['^_'] }],
      // class-methods-use-this: too aggressive for Svelte stores / handlers
      'class-methods-use-this': 'off',
      // max-classes-per-file: not useful in monorepo
      'max-classes-per-file': 'off',
      // no-plusplus: i++ in tests is fine
      'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
      // lines-between-class-members: stylistic, Prettier handles
      'lines-between-class-members': 'off',
      // object-curly-newline: Prettier handles
      'object-curly-newline': 'off',
      // arrow-body-style: 'off' is fine; Prettier and TS handle readability
      'arrow-body-style': 'off',
      // function-paren-newline: Prettier handles
      'function-paren-newline': 'off',
      // implicit-arrow-linebreak: Prettier handles
      'implicit-arrow-linebreak': 'off',
      // operator-linebreak: Prettier handles
      'operator-linebreak': 'off',
      // @typescript-eslint/indent: Prettier handles
      '@typescript-eslint/indent': 'off',
      // ---- @stylistic/* — turn OFF by default. Prettier handles formatting.
      // Per the TECH_STACK.md verdict: "pick a small subset... indent: 'off'
      // since Prettier handles. Don't fight Prettier."
      '@stylistic/quotes': 'off',
      '@stylistic/semi': 'off',
      '@stylistic/comma-dangle': 'off',
      '@stylistic/comma-spacing': 'off',
      '@stylistic/indent': 'off',
      '@stylistic/indent-binary-ops': 'off',
      '@stylistic/key-spacing': 'off',
      '@stylistic/keyword-spacing': 'off',
      '@stylistic/space-before-function-paren': 'off',
      '@stylistic/space-infix-ops': 'off',
      '@stylistic/space-in-parens': 'off',
      '@stylistic/spaced-comment': 'off',
      '@stylistic/no-trailing-spaces': 'off',
      '@stylistic/multi-line-comment-close': 'off',
      '@stylistic/no-extra-semi': 'off',
      '@stylistic/no-mixed-operators': 'off',
      '@stylistic/no-mixed-spaces-and-tabs': 'off',
      '@stylistic/no-tabs': 'off',
      '@stylistic/padded-blocks': 'off',
      '@stylistic/quote-props': 'off',
      '@stylistic/quote-property-names': 'off',
      '@stylistic/array-bracket-newline': 'off',
      '@stylistic/array-bracket-spacing': 'off',
      '@stylistic/object-property-newline': 'off',
      '@stylistic/object-curly-spacing': 'off',
      '@stylistic/object-curly-newline': 'off',
      '@stylistic/function-call-spacing': 'off',
      '@stylistic/function-call-argument-newline': 'off',
      '@stylistic/function-paren-newline': 'off',
      '@stylistic/arrow-spacing': 'off',
      '@stylistic/implicit-arrow-linebreak': 'off',
      '@stylistic/operator-linebreak': 'off',
      '@stylistic/wrap-iife': 'off',
      '@stylistic/wrap-regex': 'off',
      '@stylistic/template-curly-spacing': 'off',
      '@stylistic/template-tag-spacing': 'off',
      '@stylistic/yield-star-spacing': 'off',
      '@stylistic/brace-style': 'off',
      '@stylistic/curly-newline': 'off',
      '@stylistic/eol-last': 'off',
      '@stylistic/linebreak-style': 'off',
      '@stylistic/lines-around-comment': 'off',
      '@stylistic/lines-between-class-members': 'off',
      '@stylistic/max-len': 'off',
      '@stylistic/multiline-ternary': 'off',
      '@stylistic/newline-per-chained-call': 'off',
      '@stylistic/no-confusing-arrow': 'off',
      '@stylistic/no-multi-spaces': 'off',
      '@stylistic/no-whitespace-before-property': 'off',
      // @typescript-eslint/no-explicit-any: warn (not error) — escape hatch for third-party types
      '@typescript-eslint/no-explicit-any': 'warn',
      // @typescript-eslint/no-unused-vars: warn with underscore pattern
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // @typescript-eslint/consistent-type-imports: enforce
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // ---- Type-aware rules from airbnb-extended — turned off because
      // they require parserOptions.projectService + a tsconfig.json per
      // package. Each package can opt in by adding a parserOptions.project
      // override and re-enabling these.
      'n/no-sync': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },

  // 6) Per-package overrides — stricter for libs, looser for tests/migrations
  // 7a) Workspace-internal libs (contracts, design-tokens, audit, mail-guardian,
  //     telemetry): zero-tolerance, no console, no any, no process.exit
  {
    files: [
      'packages/contracts/**/*.{js,ts}',
      'packages/design-tokens/**/*.{js,ts}',
      'packages/cortex-audit/**/*.{js,ts}',
      'packages/cortex-mail-guardian/**/*.{js,ts}',
      'packages/cortex-telemetry/**/*.{js,ts}',
      'packages/cortex-hindsight-memory-mcp/**/*.{js,ts}',
      'packages/opencode-hindsight-plugin/**/*.{js,ts}',
    ],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // Node-specific n/* rules from airbnb-extended.node
      'n/no-process-exit': 'error',
      'n/no-process-env': 'error',
      // Type-aware rules (require projectService + tsconfig) are off by
      // default; each package can opt in by setting parserOptions.project.
      // '@typescript-eslint/no-floating-promises': 'error',
      // '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  // Scoped override: TS-only rule cannot be satisfied in plain JS
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      // MP-019: TS-only rule — plain JS cannot express return-type syntax
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // 7d) Plain-JS Node packages — Node ESM requires extensions on relative imports
  {
    files: [
      'packages/cortex-audit/**/*.{js,mjs}',
      'packages/cortex-telemetry/**/*.{js,mjs}',
      'packages/cortex-terminal/**/*.{js,mjs}',
    ],
    rules: {
      'import-x/extensions': ['error', 'ignorePackages', { js: 'always', mjs: 'always' }],
      // MP-019: allow index.js with extensions:always in Node ESM
      'import-x/no-useless-path-segments': ['error', { noUselessIndex: false }],
    },
  },

  // Scoped override: TanStack Router uses named exports by design
  {
    files: ['packages/dashboard-next/**/*.{ts,tsx}'],
    // MP-019: register react-hooks so legacy disable directives resolve
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': ts.plugin },
    rules: {
      // MP-019: TanStack Router convention — file routes export named Route const
      'import-x/prefer-default-export': 'off',
      // MP-019: enable hooks-deps checking at root so the legacy directives are USED
      'react-hooks/exhaustive-deps': 'warn',
      // MP-020: TanStack Router uses thrown redirect/notFound objects and the
      // server-fn runner throws a Response for typed RPC error envelopes.
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'package', name: 'Redirect', package: '@tanstack/react-router' },
            { from: 'package', name: 'NotFoundError', package: '@tanstack/router-core' },
            { from: 'lib', name: 'Response' },
          ],
        },
      ],
    },
  },

  // 7e) Test files — relax typing so test mocks don't block CI.
  {
    files: [
      '**/*.test.{ts,tsx,js,jsx}',
      '**/*.spec.{ts,tsx,js,jsx}',
      '**/__tests__/**/*.{ts,tsx,js,jsx}',
      '**/*.test.ts.snap',
      'vitest.setup.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      'import-x/no-extraneous-dependencies': 'off',
      'no-console': 'off',
    },
  },

  // MP-019: test files consume devDependencies by design
  {
    files: ['**/*.test.{ts,tsx,js}', '**/__tests__/**', '**/test/**', '**/src/test/**'],
    rules: {
      'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }],
    },
  },

  // MP-020: build scripts consume devDependencies by design
  {
    files: ['packages/*/scripts/**'],
    rules: {
      'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }],
    },
  },

  // MP-020: env reads live ONLY in designated env modules
  {
    files: ['packages/*/src/env.{js,ts}'],
    rules: {
      'n/no-process-env': 'off',
    },
  },

  // MP-028c: cortex-hindsight-memory-mcp is a CLI MCP server; process.exit and
  // process.env are expected in its entrypoint.
  {
    files: ['packages/cortex-hindsight-memory-mcp/src/index.ts'],
    rules: {
      'n/no-process-exit': 'off',
      'n/no-process-env': 'off',
      'n/hashbang': 'off',
      'n/prefer-global/process': 'off',
    },
  },

  // These Node 22 / modern-browser modules deliberately use native iteration:
  // no regenerator polyfill is involved. Retain prototype-chain, label and
  // with-statement restrictions instead of disabling syntax checks wholesale.
  {
    files: [
      'packages/dashboard-next/scripts/bootstrap-catalog.mjs',
      'packages/dashboard-next/scripts/migrate-cli.js',
      'packages/dashboard-next/scripts/server.mjs',
      'packages/dashboard-next/src/components/ai-elements/prompt-input.tsx',
      'packages/dashboard-next/src/features/Agents.tsx',
      'packages/dashboard-next/src/features/Dependencies.tsx',
      'packages/dashboard-next/src/lib/api/__tests__/notes.functions.test.ts',
      'packages/dashboard-next/src/lib/api/dependencies.functions.ts',
      'packages/dashboard-next/src/lib/api/env-browser.functions.ts',
      'packages/dashboard-next/src/lib/api/notes.functions.ts',
      'packages/dashboard-next/src/lib/attachment.tsx',
      'packages/dashboard-next/src/server/agents/chat.ts',
      'packages/dashboard-next/src/server/agents/files.ts',
      'packages/dashboard-next/src/server/backups/__tests__/backups.test.ts',
      'packages/dashboard-next/src/server/db/repos/__tests__/mail_guardian.test.ts',
      'packages/dashboard-next/src/server/incus/bridge.ts',
      'packages/dashboard-next/src/server/mcp/registry.ts',
      'packages/dashboard-next/src/server/system/dependency-scan.ts',
      'packages/opencode-hindsight-plugin/src/index.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ForInStatement', message: 'Use own entries rather than iterating the prototype chain.' },
        { selector: 'LabeledStatement', message: 'Use structured control flow rather than labels.' },
        { selector: 'WithStatement', message: 'With statements obscure lexical scope.' },
      ],
    },
  },
  {
    // Early rejection keeps bounded parsers and filesystem confinement checks flat.
    files: [
      'packages/dashboard-next/scripts/migrate-cli.js',
      'packages/dashboard-next/src/features/Dependencies.tsx',
      'packages/dashboard-next/src/lib/api/dependencies.functions.ts',
      'packages/dashboard-next/src/lib/api/notes.functions.ts',
      'packages/dashboard-next/src/lib/attachment.tsx',
      'packages/dashboard-next/src/server/agents/chat.ts',
      'packages/dashboard-next/src/server/agents/files.ts',
      'packages/dashboard-next/src/server/system/dependency-scan.ts',
    ],
    rules: { 'no-continue': 'off' },
  },
  {
    // Ordered transactions share one connection; confined filesystem scans are
    // intentionally serial so they do not create unbounded concurrent work.
    files: [
      'packages/dashboard-next/scripts/bootstrap-catalog.mjs',
      'packages/dashboard-next/scripts/migrate-cli.js',
      'packages/dashboard-next/src/lib/api/dependencies.functions.ts',
      'packages/dashboard-next/src/lib/api/env-browser.functions.ts',
      'packages/dashboard-next/src/lib/api/notes.functions.ts',
      'packages/dashboard-next/src/server/system/dependency-scan.ts',
    ],
    rules: { 'no-await-in-loop': 'off' },
  },
  {
    // Native open flags and Unix permission masks are bitfields, not arithmetic.
    files: [
      'packages/dashboard-next/src/server/agents/chat.ts',
      'packages/dashboard-next/src/server/agents/control.ts',
    ],
    rules: { 'no-bitwise': ['error', { allow: ['|', '&'] }] },
  },
  {
    // Executable installer/runtime entrypoints support direct invocation.
    files: [
      'packages/dashboard-next/scripts/bootstrap-catalog.mjs',
      'packages/dashboard-next/scripts/migrate-cli.js',
      'packages/dashboard-next/scripts/server.mjs',
    ],
    rules: { 'n/hashbang': 'off' },
  },
  {
    // This supervisor explicitly exits after closing sockets and its child,
    // with a final bounded shutdown deadline.
    files: ['packages/dashboard-next/scripts/server.mjs'],
    rules: { 'n/no-process-exit': 'off' },
  },

  {
    // Existing React views express exclusive display states with conditional
    // expressions. Preserve their render structure instead of a style-only rewrite.
    files: [
      'packages/dashboard-next/src/features/Agents.tsx',
      'packages/dashboard-next/src/features/Alerts.tsx',
      'packages/dashboard-next/src/features/Approvals.tsx',
      'packages/dashboard-next/src/features/Apps.tsx',
      'packages/dashboard-next/src/features/Dependencies.tsx',
      'packages/dashboard-next/src/features/DockerSearch.tsx',
      'packages/dashboard-next/src/features/Healthcheck.tsx',
      'packages/dashboard-next/src/features/MailGuardian.tsx',
      'packages/dashboard-next/src/features/Mcps.tsx',
      'packages/dashboard-next/src/features/Scheduler.tsx',
      'packages/dashboard-next/src/lib/attachment.tsx',
    ],
    rules: { 'no-nested-ternary': 'off' },
  },
  {
    // Stable graph colors use an intentional unsigned 32-bit string hash.
    files: ['packages/dashboard-next/src/features/Dependencies.tsx'],
    rules: { 'no-bitwise': ['error', { allow: ['>>>'] }] },
  },
  {
    // These tests inspect actual Unix permission masks on staged attachments.
    files: ['packages/dashboard-next/src/server/agents/__tests__/hermes-profile-api.limits.test.ts'],
    rules: { 'no-bitwise': ['error', { allow: ['&'] }] },
  },
  {
    // Malicious URI strings are regression inputs, never executable links.
    files: ['packages/dashboard-next/src/features/__tests__/MailGuardian.sanitize.test.ts'],
    rules: { 'no-script-url': 'off' },
  },
  {
    // TanStack route declarations reference hoisted component functions. Keep
    // checks for variables/classes, which unlike functions can hit the TDZ.
    files: [
      'packages/dashboard-next/src/routes/_authenticated.docker.$id.tsx',
      'packages/dashboard-next/src/routes/_authenticated.systemd.$unit.tsx',
    ],
    rules: { '@typescript-eslint/no-use-before-define': ['error', { functions: false }] },
  },

  // Declarations in the JavaScript audit package are the only out-of-project input.
  {
    files: ['**/*.ts', '**/*.cts', '**/*.mts', '**/*.tsx', '**/*.d.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'packages/cortex-audit/src/index.d.ts',
          ],
        },
      },
    },
  },

  // Tests and maintenance scripts have explicit no-emit projects, not an
  // unbounded inferred project. Build tsconfigs remain production-source only.
  ...['cortex-mail-guardian', 'cortex-hindsight-memory-mcp'].map((name) => ({
    files: [`packages/${name}/**/*.ts`],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: [`./packages/${name}/tsconfig.eslint.json`],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
];

// ---------------------------------------------------------------------------
// §1 — Why NOT `recommendedTypeChecked`?
//
// typescript-eslint's type-checked configs require a `project` field per
// parserOptions. The monorepo has multiple tsconfig.json files (one per
// package + the root), and configuring project service discovery adds
// fragility (CI cache invalidation, IDE drift). For M1 we ship the
// non-type-checked recommended set; per-package overrides below can opt
// into type-aware rules when each package is stable.
//
// When a package wants type-aware rules, add a `parserOptions.project`
// in that package's override block and switch to
// `ts.configs.recommendedTypeChecked`.
// ---------------------------------------------------------------------------
