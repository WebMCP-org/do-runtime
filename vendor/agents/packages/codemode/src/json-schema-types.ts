import type { JSONSchema7 } from "json-schema";
import {
  sanitizeToolName,
  toPascalCase,
  escapeJsDoc,
  quoteProp
} from "./utils";

/** Formatting for a raw type expression. Omit indent for a compact expression;
 * supply the containing line's indentation for a multiline declaration. */
export interface JsonSchemaTypeOptions {
  indent?: string;
}

interface ConversionContext {
  root: unknown;
  depth: number;
  seen: Set<unknown>;
}

/** Convert raw JSON Schema to a type expression without AI SDK or Zod imports.
 * Unsupported, malformed, and recursive branches become unknown so one bad
 * schema does not prevent generation of the remaining tool declarations. */
export function jsonSchemaToTypeExpression(
  schema: unknown,
  options?: JsonSchemaTypeOptions
): string {
  try {
    return printSchema(schema, options?.indent, {
      root: schema,
      depth: 0,
      seen: new Set()
    });
  } catch {
    // In particular, non-JSON const/enum values may contain cycles or BigInts.
    return "unknown";
  }
}

function schemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveRef(ref: string, root: unknown): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  for (const segment of ref.slice(2).split("/")) {
    if (
      !schemaObject(current) ||
      !Object.hasOwn(current, segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    )
      return undefined;
    current = current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current;
}

function union(types: string[]): string {
  return [...new Set(types)].join(" | ") || "never";
}

function nullable(result: string, schema: Record<string, unknown>): string {
  return schema.nullable === true &&
    result !== "unknown" &&
    result !== "never" &&
    result !== "null" &&
    !(Array.isArray(schema.type) && schema.type.includes("null")) &&
    !(Array.isArray(schema.enum) && schema.enum.includes(null))
    ? union([result, "null"])
    : result;
}

function printSchema(
  schema: unknown,
  indent: string | undefined,
  ctx: ConversionContext
): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (!schemaObject(schema) || ctx.depth >= 20 || ctx.seen.has(schema))
    return "unknown";
  ctx.seen.add(schema);
  const next = { ...ctx, depth: ctx.depth + 1 };
  const print = (value: unknown, inner = indent) =>
    printSchema(value, inner, next);
  try {
    if (typeof schema.$ref === "string")
      return nullable(print(resolveRef(schema.$ref, ctx.root)), schema);
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const variants = schema[keyword];
      if (Array.isArray(variants))
        return nullable(union(variants.map((value) => print(value))), schema);
    }
    if (Array.isArray(schema.allOf)) {
      return nullable(
        schema.allOf.length === 0
          ? "unknown"
          : schema.allOf.map((value) => `(${print(value)})`).join(" & "),
        schema
      );
    }
    if (Array.isArray(schema.enum))
      return nullable(union(schema.enum.map(printLiteral)), schema);
    if (Object.hasOwn(schema, "const"))
      return nullable(printLiteral(schema.const), schema);
    if (Array.isArray(schema.type)) {
      return nullable(
        union(
          schema.type.map((type) => print({ ...schema, type, nullable: false }))
        ),
        schema
      );
    }
    switch (schema.type) {
      case "string":
        return nullable("string", schema);
      case "number":
      case "integer":
        return nullable("number", schema);
      case "boolean":
        return nullable("boolean", schema);
      case "null":
        return "null";
      case "array": {
        const tuple = Array.isArray(schema.prefixItems)
          ? schema.prefixItems
          : Array.isArray(schema.items)
            ? schema.items
            : undefined;
        return nullable(
          tuple
            ? `[${tuple.map((value) => print(value)).join(", ")}]`
            : `Array<${schema.items === undefined ? "unknown" : print(schema.items)}>`,
          schema
        );
      }
      default:
        if (
          schema.type !== "object" &&
          schema.properties === undefined &&
          schema.additionalProperties === undefined
        )
          return "unknown";
    }
    const properties = schemaObject(schema.properties)
      ? Object.entries(schema.properties)
      : [];
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : []
    );
    const inner = indent === undefined ? undefined : indent + "    ";
    const fields = properties.map(([name, property]) => {
      const type = print(property, inner);
      const desc =
        schemaObject(property) && typeof property.description === "string"
          ? escapeJsDoc(property.description.replace(/\s+/g, " ").trim())
          : "";
      const format =
        schemaObject(property) && typeof property.format === "string"
          ? `@format ${escapeJsDoc(property.format)}`
          : "";
      const comment =
        desc && format
          ? `/**\n${inner} * ${desc}\n${inner} * ${format}\n${inner} */`
          : desc || format
            ? `/** ${desc || format} */`
            : "";
      return {
        type,
        optional: !required.has(name),
        text: `${quoteProp(name)}${required.has(name) ? "" : "?"}: ${type};`,
        comment
      };
    });
    const additionalType =
      schema.additionalProperties === false
        ? "never"
        : print(schema.additionalProperties ?? true, inner);
    if (fields.length === 0)
      return nullable(`Record<string, ${additionalType}>`, schema);
    if (schema.additionalProperties !== false) {
      // A TS index signature also covers named properties. JSON Schema's
      // additionalProperties does not; include those types (and optional
      // undefined) so valid records are not rendered uninhabitable.
      const type =
        additionalType === "unknown"
          ? "unknown"
          : union([
              additionalType,
              ...fields.map((field) => field.type),
              ...(fields.some((field) => field.optional) ? ["undefined"] : [])
            ]);
      fields.push({
        type,
        optional: false,
        text: `[key: string]: ${type};`,
        comment: ""
      });
    }
    const result =
      indent === undefined
        ? `{ ${fields.map((field) => field.text).join(" ")} }`
        : `{\n${fields.map((field) => `${field.comment ? `${inner}${field.comment}\n` : ""}${inner}${field.text}`).join("\n")}\n${indent}}`;
    return nullable(result, schema);
  } finally {
    ctx.seen.delete(schema);
  }
}

function printLiteral(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) return "unknown";
  return JSON.stringify(value) ?? "unknown";
}

/** Convert a JSON Schema to a TypeScript type declaration. */
export function jsonSchemaToType(schema: unknown, typeName: string): string {
  return `type ${typeName} = ${jsonSchemaToTypeExpression(schema, { indent: "" })}`;
}

/**
 * Extract field descriptions from a JSON Schema's properties.
 */
function extractJsonSchemaDescriptions(
  schema: JSONSchema7
): Record<string, string> {
  const descriptions: Record<string, string> = {};
  if (schema.properties) {
    for (const [fieldName, propSchema] of Object.entries(schema.properties)) {
      if (
        propSchema &&
        typeof propSchema === "object" &&
        propSchema.description
      ) {
        descriptions[fieldName] = propSchema.description;
      }
    }
  }
  return descriptions;
}

/**
 * A tool descriptor using plain JSON Schema (no Zod or AI SDK dependency).
 */
export interface JsonSchemaToolDescriptor {
  description?: string;
  inputSchema: JSONSchema7;
  outputSchema?: JSONSchema7;
}

export type JsonSchemaToolDescriptors = Record<
  string,
  JsonSchemaToolDescriptor
>;

/**
 * Generate TypeScript type definitions from tool descriptors with JSON Schema.
 * This function has NO dependency on the AI SDK or Zod — it works purely with
 * JSON Schema objects.
 *
 * Use this when you have raw JSON Schema (e.g. from OpenAPI specs, MCP tool
 * definitions, etc.) and don't need the AI SDK.
 */
export function generateTypesFromJsonSchema(
  tools: JsonSchemaToolDescriptors
): string {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    const safeName = sanitizeToolName(toolName);
    const typeName = toPascalCase(safeName);

    try {
      const inputType = jsonSchemaToType(tool.inputSchema, `${typeName}Input`);

      const outputType = tool.outputSchema
        ? jsonSchemaToType(tool.outputSchema, `${typeName}Output`)
        : `type ${typeName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      const paramLines = (() => {
        try {
          const paramDescs = extractJsonSchemaDescriptions(tool.inputSchema);
          return Object.entries(paramDescs).map(
            ([fieldName, desc]) => `@param input.${fieldName} - ${desc}`
          );
        } catch {
          return [];
        }
      })();
      const jsdocLines: string[] = [];
      if (tool.description?.trim()) {
        jsdocLines.push(
          escapeJsDoc(tool.description.trim().replace(/\r?\n/g, " "))
        );
      } else {
        jsdocLines.push(escapeJsDoc(toolName));
      }
      for (const pd of paramLines) {
        jsdocLines.push(escapeJsDoc(pd.replace(/\r?\n/g, " ")));
      }

      const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
      availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    } catch {
      availableTypes += `\ntype ${typeName}Input = unknown`;
      availableTypes += `\ntype ${typeName}Output = unknown`;

      availableTools += `\n\t/**\n\t * ${escapeJsDoc(toolName)}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    }
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
