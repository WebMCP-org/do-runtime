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
});
