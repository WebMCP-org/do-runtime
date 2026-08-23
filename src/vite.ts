import MagicString from "magic-string";
import {
  createFilter,
  Visitor,
  type ESTree,
  type FilterPattern,
  type Plugin,
} from "vite";

const MARKER = "/* @do-runtime-gated */";
const IMPORT =
  'import { __gateAsyncIterable, __gateAwait, __resumeAwait } from "@mcp-b/do-runtime/gate";';

export interface DoRuntimeAwaitTransformOptions {
  include?: FilterPattern;
  exclude?: FilterPattern;
}

function patterns(pattern: FilterPattern | undefined): readonly (string | RegExp)[] {
  if (pattern === undefined || pattern === null) return [];
  return typeof pattern === "string" || pattern instanceof RegExp ? [pattern] : pattern;
}

type AwaitCoverage = {
  readonly total: number;
  readonly transformed: number;
};

function directCallName(node: ESTree.Node | null | undefined): string | undefined {
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
      const argument = node.arguments[0];
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

  return {
    name: "do-runtime-await-transform",
    enforce: "post",
    configResolved(config) {
      development = config.command === "serve";
    },
    transform(code, id) {
      if (!code.includes("await") || code.includes(MARKER) || !filter(id)) return null;

      const source = new MagicString(code);
      let transformed = false;
      const program = this.parse(code);
      new Visitor({
        AwaitExpression(node) {
          source.prependLeft(node.start, "__resumeAwait((");
          source.prependLeft(node.argument.start, "__gateAwait((");
          source.appendRight(
            node.argument.end,
            development ? `), ${JSON.stringify(id)})` : "))",
          );
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
      if (!transformed) return null;

      const insertionPoint = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;
      source.appendLeft(insertionPoint, `${MARKER}\n${IMPORT}\n`);
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
