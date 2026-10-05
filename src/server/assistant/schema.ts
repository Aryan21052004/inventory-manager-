import "server-only";

import { Type, type Schema } from "@google/genai";
import { z } from "zod";

/**
 * Turns a tool's zod argument schema into the declaration Gemini is shown.
 *
 * One schema, two uses. The zod object is what the server validates the
 * model's arguments against before anything runs; the declaration derived
 * from it here is what tells the model which arguments exist. Writing the two
 * by hand would let them drift — a parameter the model is told about but the
 * validator rejects, or the reverse — so the declaration is never written by
 * hand.
 *
 * Deliberately a small subset: objects of strings (optionally enumerated),
 * integers and booleans. That covers every tool, and anything else throws here
 * — at module load, caught by the test suite — rather than being sent to the
 * API as a shape it may reject or quietly misread. Validation-only details
 * such as string patterns and lengths are left out of the declaration; the
 * server enforces them either way.
 */

interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

function scalar(name: string, node: JsonSchemaNode): Schema {
  const described = node.description ? { description: node.description } : {};

  switch (node.type) {
    case "string":
      return {
        ...described,
        type: Type.STRING,
        ...(node.enum ? { enum: node.enum.map(String) } : {}),
      };
    case "integer":
      return {
        ...described,
        type: Type.INTEGER,
        ...(node.minimum !== undefined ? { minimum: node.minimum } : {}),
        ...(node.maximum !== undefined ? { maximum: node.maximum } : {}),
      };
    case "boolean":
      return { ...described, type: Type.BOOLEAN };
    default:
      throw new Error(
        `Assistant tool parameter "${name}" has unsupported type ${JSON.stringify(node.type)}.`,
      );
  }
}

/**
 * The `parameters` for a function declaration, or `undefined` for a tool that
 * takes no arguments — Gemini rejects an OBJECT schema with no properties, so
 * an argument-less tool declares none at all.
 */
export function toGeminiParameters(schema: z.ZodType): Schema | undefined {
  const root = z.toJSONSchema(schema) as JsonSchemaNode;

  if (root.type !== "object") {
    throw new Error("Assistant tool arguments must be an object schema.");
  }

  const entries = Object.entries(root.properties ?? {});
  if (entries.length === 0) return undefined;

  return {
    type: Type.OBJECT,
    properties: Object.fromEntries(
      entries.map(([name, node]) => [name, scalar(name, node)]),
    ),
    ...(root.required && root.required.length > 0
      ? { required: root.required }
      : {}),
  };
}
