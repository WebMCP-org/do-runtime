import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  jsonSchemaToType,
  jsonSchemaToTypeExpression
} from "../json-schema-types";

function diagnostics(schema: unknown, assignments: string): string[] {
  const source = `${jsonSchemaToType(schema, "Value")};\n${assignments}`;
  const directory = mkdtempSync(join(tmpdir(), "codemode-schema-types-"));
  try {
    const path = join(directory, "input.ts");
    writeFileSync(path, source);
    // Use the real compiler host and its standard library. Only generated
    // declarations and value assignments are test inputs.
    const program = ts.createProgram([path], {
      strict: true,
      noEmit: true,
      types: [],
      lib: ["lib.es2021.d.ts"]
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("raw JSON Schema type expressions", () => {
  it("keeps union items inside their array and intersection operands", () => {
    const array = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] }
    };
    expect(diagnostics(array, 'const valid: Value = ["a", 1];')).toEqual([]);
    expect(diagnostics(array, 'const invalid: Value = "a";')).toHaveLength(1);
    const intersection = {
      allOf: [{ enum: ["left", "right"] }, { const: "right" }]
    };
    expect(diagnostics(intersection, 'const valid: Value = "right";')).toEqual(
      []
    );
    expect(
      diagnostics(intersection, 'const invalid: Value = "left";')
    ).toHaveLength(1);
  });

  it("keeps optional and named properties assignable alongside dictionary entries", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: { type: "number" }
    };
    expect(
      diagnostics(
        schema,
        'const valid: Value = { name: "a", count: 1 }; const alsoValid: Value = { count: 1 };'
      )
    ).toEqual([]);
    expect(
      diagnostics(schema, "const invalid: Value = { name: 1 };")
    ).toHaveLength(1);
    expect(
      diagnostics(
        { type: "object", additionalProperties: false },
        "const invalid: Value = { extra: 1 };"
      )
    ).toHaveLength(1);
  });

  it("prints open objects, literal values and tuples with usable types", () => {
    expect(
      diagnostics(
        { type: "object", properties: { name: { type: "string" } } },
        'const valid: Value = { name: "a", extra: true };'
      )
    ).toEqual([]);
    expect(
      diagnostics(
        {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }]
        },
        'const valid: Value = ["a", 1];'
      )
    ).toEqual([]);
    expect(
      diagnostics(
        { const: { name: "a" } },
        'const valid: Value = { name: "a" };'
      )
    ).toEqual([]);
    expect(
      diagnostics({ enum: [] }, 'const invalid: Value = "a";')
    ).toHaveLength(1);
  });

  it("supports compact and indented rendering without changing type semantics", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string", description: "One\n name */" } }
    };
    const compact = jsonSchemaToTypeExpression(schema);
    const pretty = jsonSchemaToTypeExpression(schema, { indent: "  " });
    expect(compact).not.toContain("\n");
    expect(compact).not.toContain("/**");
    expect(pretty).toContain("/** One name *\\/ */");
    expect(pretty.endsWith("\n  }")).toBe(true);
  });

  it("bounds recursive and malformed schemas and resolves internal refs", () => {
    const circular: { type: string; properties?: object } = { type: "object" };
    circular.properties = { self: circular };
    expect(jsonSchemaToTypeExpression(circular)).toContain("self?: unknown");
    for (const invalid of [
      undefined,
      null,
      7,
      () => 1,
      { anyOf: "bad" },
      { properties: [] }
    ])
      expect(() => jsonSchemaToTypeExpression(invalid)).not.toThrow();
    expect(
      jsonSchemaToTypeExpression({
        $defs: { "a/b": { type: "string" } },
        $ref: "#/$defs/a~1b"
      })
    ).toBe("string");
    expect(
      jsonSchemaToTypeExpression({ type: ["string", "null"], nullable: true })
    ).toBe("string | null");
    expect(
      jsonSchemaToTypeExpression({
        $defs: { Never: false },
        $ref: "#/$defs/Never"
      })
    ).toBe("never");
    expect(jsonSchemaToTypeExpression({ $ref: "#/toString" })).toBe("unknown");
    expect(jsonSchemaToTypeExpression({ $ref: "#" })).toBe("unknown");
    const literal: { self?: object } = {};
    literal.self = literal;
    expect(jsonSchemaToTypeExpression({ const: literal })).toBe("unknown");
    const deep = Array.from({ length: 25 }).reduce<object>(
      (child) => ({ type: "array", items: child }),
      { type: "boolean" }
    );
    expect(jsonSchemaToTypeExpression(deep)).not.toContain("boolean");
  });

  it("still inlines a shared $ref target at each use", () => {
    expect(
      jsonSchemaToTypeExpression({
        type: "object",
        properties: {
          home: { $ref: "#/$defs/Address" },
          work: { $ref: "#/$defs/Address" }
        },
        required: ["home"],
        $defs: {
          Address: {
            type: "object",
            properties: { street: { type: "string" } }
          }
        }
      })
    ).toBe(
      "{ home: { street?: string; [key: string]: unknown; }; work?: { street?: string; [key: string]: unknown; }; [key: string]: unknown; }"
    );
  });

  // The printer stops emitting at 100,000 characters; the node that crosses
  // it may still repeat its fields once in an index signature.
  const bound = 200_000;

  it("bounds output when $defs reference each other", () => {
    // Each definition inlines the next three, and its index signature repeats
    // them: 2.7 MB for ten definitions without a bound.
    const $defs: Record<string, unknown> = {
      Tree: {
        type: "object",
        properties: {
          children: { type: "array", items: { $ref: "#/$defs/Tree" } }
        }
      }
    };
    for (let i = 0; i < 10; i++) {
      const properties: Record<string, unknown> = { id: { type: "string" } };
      for (const [name, j] of [
        ["a", i + 1],
        ["b", i + 2],
        ["c", i + 3]
      ] as const)
        if (j < 10) properties[name] = { $ref: `#/$defs/Node${j}` };
      $defs[`Node${i}`] = {
        type: "object",
        properties,
        additionalProperties: { type: "string" }
      };
    }
    const schema = {
      type: "object",
      properties: {
        root: { $ref: "#/$defs/Node0" },
        tree: { $ref: "#/$defs/Tree" }
      },
      $defs
    };
    const started = performance.now();
    const declaration = jsonSchemaToType(schema, "Value");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(declaration.length).toBeLessThan(bound);
    expect(
      diagnostics(schema, 'const valid: Value = { root: { id: "0" } };')
    ).toEqual([]);
  });

  it("bounds nested index signatures that repeat their field types", () => {
    // 185 MB at depth 19 without a bound, with no $ref at all.
    let schema: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 19; depth++)
      schema = {
        type: "object",
        properties: { a: schema, b: { type: "number" } },
        additionalProperties: { type: "string" }
      };
    const started = performance.now();
    const declaration = jsonSchemaToType(schema, "Value");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(declaration.length).toBeLessThan(bound);
    expect(diagnostics(schema, "const valid: Value = { b: 1 };")).toEqual([]);
  });
});
