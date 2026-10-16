// Architecture rules (docs/architecture.md). Run with `pnpm arch` and in CI.
//
//   main.ts → bootstrap/ → features/ → core/ → core/kernel/
//
// Dependencies only point right. Features never import each other; anything two features
// share belongs in core/. Outside a core module, only its index.ts may be imported.

const CORE_PUBLIC_API = '^src/core/[^/]+/index\\.ts$'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies.',
      from: {},
      to: { circular: true },
    },

    // --- layers ---
    {
      name: 'kernel-is-the-foundation',
      severity: 'error',
      comment: 'core/kernel (Result, errors, logger) depends on nothing else in the project.',
      from: { path: '^src/core/kernel/' },
      to: { path: '^src/', pathNot: '^src/core/kernel/' },
    },
    {
      name: 'core-knows-no-features',
      severity: 'error',
      comment: 'core/ is reusable: it never depends on features, bootstrap or main.ts.',
      from: { path: '^src/core/' },
      to: { path: '^src/(features|bootstrap)/|^src/main\\.ts$' },
    },
    {
      name: 'features-know-no-bootstrap',
      severity: 'error',
      comment:
        'Features receive what they need through CommandDeps/ToolContext, not from bootstrap.',
      from: { path: '^src/features/' },
      to: { path: '^src/bootstrap/|^src/main\\.ts$' },
    },
    {
      name: 'main-only-starts-bootstrap',
      severity: 'error',
      comment: 'main.ts wires the process to bootstrap; it holds no feature logic.',
      from: { path: '^src/main\\.ts$' },
      to: { path: '^src/features/' },
    },

    // --- boundaries ---
    {
      name: 'features-are-independent',
      severity: 'error',
      comment: 'A feature never imports another feature; move shared code to core/.',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/', pathNot: '^src/features/$1/' },
    },
    {
      name: 'bootstrap-uses-feature-index',
      severity: 'error',
      comment: 'bootstrap registers features through their index.ts only.',
      from: { path: '^src/bootstrap/' },
      to: { path: '^src/features/[^/]+/.+', pathNot: '^src/features/[^/]+/index\\.ts$' },
    },
    {
      name: 'core-modules-use-public-api',
      severity: 'error',
      comment: 'A core module imports another core module only through its index.ts.',
      from: { path: '^src/core/([^/]+)/' },
      to: { path: '^src/core/[^/]+/.+', pathNot: ['^src/core/$1/', CORE_PUBLIC_API] },
    },
    {
      name: 'outside-core-use-public-api',
      severity: 'error',
      comment: 'Features, bootstrap and main.ts import core modules only through their index.ts.',
      from: { path: '^src/(features|bootstrap)/|^src/main\\.ts$' },
      to: { path: '^src/core/[^/]+/.+', pathNot: [CORE_PUBLIC_API, '/providers/'] },
    },
    {
      name: 'only-composition-root-imports-providers',
      severity: 'error',
      comment:
        'Only bootstrap/composition-root.ts instantiates providers; the rest depends on ports.',
      from: { path: '^src/', pathNot: ['^src/bootstrap/composition-root\\.ts$', '/providers/'] },
      to: { path: '/providers/' },
    },

    // --- hygiene ---
    {
      name: 'no-tests-in-src',
      severity: 'error',
      comment: 'Tests live in tests/ (unit tests mirror src/); src/ holds production code only.',
      from: { path: '\\.(test|spec)\\.ts$' },
      to: {},
    },
    {
      name: 'src-does-not-import-tests',
      severity: 'error',
      comment: 'Production code never imports tests, fakes or fixtures.',
      from: { path: '^src/' },
      to: { path: '^tests/' },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code does not use devDependencies.',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // TypeScript 7 does not publish a JS API yet; swc parses TS without it.
    parser: 'swc',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js'],
    },
  },
}
