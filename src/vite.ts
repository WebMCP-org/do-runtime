import MagicString from "magic-string";
import {
  createFilter,
  Visitor,
  type FilterPattern,
  type Plugin,
} from "vite";

const MARKER = "/* @do-runtime-gated */";
const IMPORT =
  'import { __gate, __gateAsyncIterable } from "@mcp-b/do-runtime/gate";';

export interface DoRuntimeAwaitTransformOptions {
  include?: FilterPattern;
  exclude?: FilterPattern;
}

function patterns(pattern: FilterPattern | undefined): readonly (string | RegExp)[] {
  if (pattern === undefined || pattern === null) return [];
  return typeof pattern === "string" || pattern instanceof RegExp ? [pattern] : pattern;
}

/** Rewrite syntactic awaits in selected actor-bundled modules to re-enter their input gate. */
export function doRuntimeAwaitTransform(options?: DoRuntimeAwaitTransformOptions): Plugin {
  const filter = createFilter(options?.include, [
    "**/node_modules/@mcp-b/do-runtime/**",
    "**/@mcp-b/do-runtime/gate",
    ...patterns(options?.exclude),
  ]);

  return {
    name: "do-runtime-await-transform",
    enforce: "post",
    transform(code, id) {
      if (!code.includes("await") || code.includes(MARKER) || !filter(id)) return null;

      const source = new MagicString(code);
      let transformed = false;
      const program = this.parse(code);
      new Visitor({
        AwaitExpression(node) {
          source.prependLeft(node.argument.start, "__gate((");
          source.appendRight(node.argument.end, "))");
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
  };
}
