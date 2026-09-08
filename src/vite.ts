import MagicString from "magic-string";
import {
  createFilter,
  transformWithOxc,
  Visitor,
  type ESTree,
  type FilterPattern,
  type Plugin,
} from "vite";

const MARKER = "/* @do-runtime-gated */";
const IMPORT =
  'import { __gateAsyncIterable, __gateAwait, __resumeAwait } from "@mcp-b/do-runtime/gate";';
const OXC_ASYNC_GENERATOR = /^@oxc-project\+runtime@[^/]+\/helpers\/esm\/wrapAsyncGenerator\.js$/;

function correctAsyncGeneratorReturn(code: string, id: string) {
  // Oxc 0.144.0 repeats .return() after an await in finally, skipping cleanup.
  // Match Babel's distinction between await (k=0) and delegated yield (k=1):
  // https://github.com/babel/babel/blob/main/packages/babel-helpers/src/helpers/wrapAsyncGenerator.ts
  // Keep this shape check until Vite's bundled Oxc helper incorporates that fix.
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

export interface DoRuntimeAwaitTransformOptions {
  include?: FilterPattern;
  exclude?: FilterPattern;
  /** Lower async functions/generators so the browser async_hooks shim can bind continuations. */
  asyncContext?: boolean;
}

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
