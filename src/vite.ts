import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import {
  createFilter,
  transformWithOxc,
  Visitor,
  type Alias,
  type ESTree,
  type FilterPattern,
  type Plugin,
} from "vite";
// `.js` here and in actor-scope-globals.ts keeps Vite's bundle config loader from printing its
// four-line "unsupported by `configLoader: 'native'`" warning on every config load from source.
// The native loader cannot load this file from source either way (that needs `.ts` specifiers
// and `allowImportingTsExtensions`), and the built dist is unaffected.
import { ACTOR_SCOPE_GLOBALS } from "./api/actor-scope-globals.js";

const MARKER = "/* @do-runtime-gated */";
const IMPORT =
  'import { __gateAsyncIterable, __gateAwait, __resumeAwait } from "@mcp-b/do-runtime/gate";';
const OXC_ASYNC_GENERATOR = /^@oxc-project\+runtime@[^/]+\/helpers\/esm\/wrapAsyncGenerator\.js$/;

function correctAsyncGeneratorReturn(code: string, id: string) {
  // Oxc 0.149.0 repeats .return() after an await in finally, skipping cleanup.
  // Match Babel's distinction between await (k=0) and delegated yield (k=1):
  // https://github.com/babel/babel/blob/main/packages/babel-helpers/src/helpers/wrapAsyncGenerator.ts
  // Keep this shape check until Vite's bundled Oxc helper incorporates that fix.
  // Another async-context transform in the same pipeline may have corrected it already.
  if (code.includes('var i = "return" === r && o.k ? "return" : "next";')) return null;
  const before = 'var i = "return" === r ? "return" : "next";';
  const start = code.indexOf(before);
  if (
    start < 0 ||
    code.indexOf(before, start + before.length) >= 0 ||
    !code.includes("if (!o.k || t.done) return resume(i, t);")
  ) {
    throw new Error(
      `do-runtime: Oxc async-generator helper changed; review or remove the return/await correction: ${id}`,
    );
  }
  const source = new MagicString(code);
  source.overwrite(
    start,
    start + before.length,
    'var i = "return" === r && o.k ? "return" : "next";',
  );
  return {
    code: source.toString(),
    map: source.generateMap({ hires: "boundary", includeContent: true, source: id }),
  };
}

/**
 * The prelude a same-realm host prefixes to each facet bundle. It binds the actor globals to the
 * scope registered at `globalThis[registry][scope]`, where `scope` is the bundle URL's `scope`
 * search parameter.
 */
export function facetScopeBanner({ registry }: { registry: string }): string {
  return `const __facetKey = new URL(import.meta.url).searchParams.get("scope");
const __facetScope = globalThis[${JSON.stringify(registry)}]?.[__facetKey];
if (__facetScope === undefined) throw new Error(\`facet module has no scope named \${__facetKey}\`);
const { ${ACTOR_SCOPE_GLOBALS.join(", ")} } = __facetScope;`;
}

export interface DoRuntimeAwaitTransformOptions {
  include?: FilterPattern;
  exclude?: FilterPattern;
  /** Lower async functions/generators so the browser async_hooks shim can bind continuations. */
  asyncContext?: boolean;
}

/**
 * The package's own files for the imports this plugin injects: siblings of the built
 * `dist/vite.js`. Node loads the plugin from its real path, which with Vite's default
 * `preserveSymlinks` is the path Vite resolves an application import of the same subpath to,
 * so both share one module instance. Run from source, the plugin leaves them to the host.
 */
const INJECTED_MODULES = new Map(
  import.meta.url.endsWith(".js")
    ? Object.entries({
        "@mcp-b/do-runtime/gate": "./gate.js",
        "@mcp-b/do-runtime/browser/async-hooks": "./browser/async-hooks.js",
      }).map(([id, path]): [string, string] => [id, fileURLToPath(new URL(path, import.meta.url))])
    : [],
);

function patterns(pattern: FilterPattern | undefined): readonly (string | RegExp)[] {
  if (pattern === undefined || pattern === null) return [];
  return typeof pattern === "string" || pattern instanceof RegExp ? [pattern] : pattern;
}

type AwaitCoverage = {
  readonly total: number;
  readonly transformed: number;
};

function unparenthesized(node: ESTree.Node | null | undefined): ESTree.Node | null | undefined {
  while (node?.type === "ParenthesizedExpression") node = node.expression;
  return node;
}

function directCallName(node: ESTree.Node | null | undefined): string | undefined {
  node = unparenthesized(node);
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier") return undefined;
  return node.callee.name;
}

function countAwaitCoverage(program: ESTree.Program): AwaitCoverage {
  let total = 0;
  let transformed = 0;
  new Visitor({
    AwaitExpression() {
      total += 1;
    },
    CallExpression(node) {
      if (directCallName(node) !== "__resumeAwait") return;
      const argument = unparenthesized(node.arguments[0]);
      if (argument?.type !== "AwaitExpression") return;
      if (directCallName(argument.argument) === "__gateAwait") transformed += 1;
    },
    ForOfStatement(node) {
      if (!node.await) return;
      total += 1;
      if (directCallName(node.right) === "__gateAsyncIterable") transformed += 1;
    },
    VariableDeclaration(node) {
      if (node.kind === "await using") total += 1;
    },
  }).visit(program);
  return { total, transformed };
}

/** Rewrite syntactic awaits in selected actor-bundled modules to re-enter their input gate. */
export function doRuntimeAwaitTransform(options?: DoRuntimeAwaitTransformOptions): Plugin {
  const filter = createFilter(options?.include, [
    "**/node_modules/@mcp-b/do-runtime/**",
    "**/@mcp-b/do-runtime/gate",
    ...patterns(options?.exclude),
  ]);
  let development = false;
  const loweredCoverage = new Map<string, AwaitCoverage>();

  return {
    name: "do-runtime-await-transform",
    enforce: "post",
    // Ahead of aliases and Vite's own resolver, which cannot find this package from inside a
    // strict pnpm dependency.
    resolveId: { order: "pre", handler: (id) => INJECTED_MODULES.get(id) ?? null },
    configResolved(config) {
      development = config.command === "serve";
    },
    async transform(code, id) {
      if (options?.asyncContext && id.startsWith("\0") && OXC_ASYNC_GENERATOR.test(id.slice(1))) {
        return correctAsyncGeneratorReturn(code, id);
      }
      if (
        (!code.includes("await") && !(options?.asyncContext && code.includes("async"))) ||
        code.includes(MARKER) ||
        !filter(id)
      )
        return null;

      const source = new MagicString(code);
      let transformed = false;
      const program = this.parse(code);
      new Visitor({
        AwaitExpression(node) {
          source.prependLeft(node.start, "__resumeAwait((");
          source.prependLeft(node.argument.start, "__gateAwait((");
          source.appendRight(node.argument.end, development ? `), ${JSON.stringify(id)})` : "))");
          source.appendRight(node.end, "))");
          transformed = true;
        },
        ForOfStatement(node) {
          if (!node.await) return;
          source.prependLeft(node.right.start, "__gateAsyncIterable((");
          source.appendRight(node.right.end, "))");
          transformed = true;
        },
      }).visit(program);
      if (!transformed && !options?.asyncContext) return null;

      const insertionPoint = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;
      source.appendLeft(insertionPoint, `${MARKER}\n${IMPORT}\n`);
      if (options?.asyncContext) {
        const coverage = countAwaitCoverage(this.parse(source.toString()));
        if (coverage.total !== coverage.transformed) {
          this.error(
            `do-runtime await transform missed included awaits:\n${id}: ${coverage.transformed}/${coverage.total}`,
          );
        }
        loweredCoverage.set(id, coverage);
        source.appendLeft(insertionPoint, 'import "@mcp-b/do-runtime/browser/async-hooks";\n');
        // Native await never calls Promise.prototype.then. Oxc's generator
        // helpers do, making each continuation an ordinary bound callback.
        return await transformWithOxc(
          source.toString(),
          id,
          { target: "es2016", lang: "js" },
          source.generateMap({ hires: "boundary", includeContent: true, source: id }),
        );
      }
      return {
        code: source.toString(),
        map: source.generateMap({ hires: "boundary", includeContent: true, source: id }),
      };
    },
    buildEnd(error) {
      if (error !== undefined || development) return;
      const incomplete: string[] = [];
      let total = 0;
      let transformed = 0;
      let modules = 0;
      for (const id of this.getModuleIds()) {
        if (!filter(id)) continue;
        const lowered = loweredCoverage.get(id);
        if (lowered !== undefined) {
          total += lowered.total;
          transformed += lowered.transformed;
          modules += 1;
        }
        const code = this.getModuleInfo(id)?.code;
        if (!code?.includes("await")) continue;

        const coverage = countAwaitCoverage(this.parse(code));
        if (coverage.total === 0) continue;
        total += coverage.total;
        transformed += coverage.transformed;
        modules += 1;
        if (coverage.transformed !== coverage.total) {
          incomplete.push(`${id}: ${coverage.transformed}/${coverage.total}`);
        }
      }

      if (incomplete.length > 0) {
        incomplete.sort();
        this.error(`do-runtime await transform missed included awaits:\n${incomplete.join("\n")}`);
      }

      if (total > 0) {
        this.info(
          `do-runtime await transform: ${transformed}/${total} awaits gated in ${modules} await-bearing included modules`,
        );
      }
    },
  };
}

/** Aliases to built siblings of `dist/vite.js`, as for `INJECTED_MODULES`; none from source. */
function packageAliases(
  entries: readonly (readonly [find: string | RegExp, path: string])[],
): Alias[] {
  if (!import.meta.url.endsWith(".js")) return [];
  return entries.map(([find, path]) => ({
    find,
    replacement: fileURLToPath(new URL(path, import.meta.url)),
  }));
}

/**
 * The platform modules a Workers bundle imports, aliased to this package's own files so
 * `newRpcSession()` and application code see one `RpcTarget` class. Run from source it returns
 * none: this repository's lanes alias the source files.
 */
export function workersModuleAliases(): Alias[] {
  return packageAliases([
    ["cloudflare:workers", "./cloudflare-workers.js"],
    ["cloudflare:email", "./cloudflare-email.js"],
  ]);
}

export interface BrowserHostOptions {
  /** Actor and SDK modules whose awaits must re-enter the actor's input gate. */
  include: FilterPattern;
  /** Alias `async_hooks` to the browser shim and lower async functions for it (default true). */
  asyncContext?: boolean;
  /**
   * One self-contained bundle per facet realm: a chunk it imports would bind that chunk's free
   * `WebSocketPair`, streams and timers to the root actor's scope. Worker bundles build without
   * code splitting, matched chunks get `facetScopeBanner({ registry })`, and the build fails if
   * one imports anything. Match on `chunk.facadeModuleId`: a name can also match a shared chunk.
   */
  facets?: {
    registry: string;
    match(chunk: { name: string; facadeModuleId?: string | null }): unknown;
  };
}

/**
 * The Workers bundle contract of a browser host, for the application's `plugins`: Vite drops a
 * Worker plugin's `resolve` config, while aliases returned here reach pre-bundled dependencies
 * too. Register it in a browser-only config: the aliases apply to every Vite environment and take
 * precedence over the application's own entries.
 *
 * Workers build as ES modules, which top-level await and module chunks need. They keep class
 * names, as wrangler's `keep_names` does by default, because the Agents SDK routes and persists
 * sub-agents by `constructor.name`. They run the await transform. Unbundled development serves
 * Worker modules through the application plugins, so the transform also runs there while
 * serving, and only then.
 */
export function browserHost(options: BrowserHostOptions): Plugin[] {
  const { facets } = options;
  const asyncContext = options.asyncContext ?? true;
  const transform = () => doRuntimeAwaitTransform({ include: options.include, asyncContext });
  return [
    {
      name: "do-runtime-browser-host",
      config: () => ({
        resolve: {
          alias: [
            ...workersModuleAliases(),
            ...packageAliases(
              asyncContext ? [[/^(node:)?async_hooks$/, "./browser/async-hooks.js"]] : [],
            ),
          ],
        },
        worker: {
          format: "es",
          plugins: () => [transform(), ...(facets ? [facetBundles(facets)] : [])],
          rolldownOptions: {
            output: { keepNames: true, ...(facets ? { codeSplitting: false } : {}) },
          },
        },
      }),
      configureServer(server) {
        if (facets && !server.environments.client.config.isBundled) {
          server.config.logger.warnOnce(
            "do-runtime: unbundled dev serves facet modules without their scope banner, so their " +
              "globals resolve to the root actor's; load facets from a build.",
          );
        }
      },
    },
    { ...transform(), apply: "serve" },
    ...(facets ? [facetBundles(facets)] : []),
  ];
}

function facetBundles({ registry, match }: NonNullable<BrowserHostOptions["facets"]>): Plugin {
  const banner = facetScopeBanner({ registry });
  return {
    name: "do-runtime-facet-bundles",
    // The output hook rather than `output.banner`, so it composes with a host's own banner.
    banner: (chunk) => (match(chunk) ? banner : ""),
    generateBundle(_, bundle) {
      const shared = Object.values(bundle).flatMap((chunk) => {
        if (chunk.type !== "chunk" || !match(chunk)) return [];
        // An inlined dynamic import is listed as the chunk's own file.
        const imports = [...chunk.imports, ...chunk.dynamicImports].filter(
          (file) => file !== chunk.fileName,
        );
        return imports.length > 0
          ? [`facet chunk ${chunk.fileName} imports ${imports.join(", ")}`]
          : [];
      });
      if (shared.length > 0) {
        this.error(
          `do-runtime: a facet must build to one self-contained chunk; a chunk it imports binds ` +
            `its globals to the root actor's scope:\n${shared.join("\n")}`,
        );
      }
    },
  };
}
