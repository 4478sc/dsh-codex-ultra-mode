import { randomUUID } from "node:crypto";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createUserMessage(input) {
  return deepFreeze(structuredClone({
    ...input,
    id: randomUUID(),
    role: "user"
  }));
}

function compileProperties(properties) {
  const compiled = {};
  const required = [];
  for (const [name, schema] of Object.entries(properties)) {
    if (schema.required === true) required.push(name);
    compiled[name] = compileSchema(schema);
  }
  return {
    properties: compiled,
    ...(required.length === 0 ? {} : { required })
  };
}

function compileSchema(schema) {
  if (schema === true || schema === false) return schema;
  const compiled = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required") continue;
    if (key === "properties") {
      Object.assign(compiled, compileProperties(value));
    } else if (key === "items") {
      compiled.items = compileSchema(value);
    } else if (key === "oneOf") {
      compiled.oneOf = value.map(compileSchema);
    } else if (key === "additionalProperties" && typeof value === "object" && value !== null) {
      compiled.additionalProperties = compileSchema(value);
    } else {
      compiled[key] = value;
    }
  }
  return compiled;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSchema(schema, value, path = "") {
  const violations = [];
  const at = path === "" ? "arguments" : path;
  if (schema.const !== undefined && !sameJsonValue(value, schema.const)) {
    violations.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => sameJsonValue(value, entry))) {
    violations.push(`${at} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      violations.push(`${at} must be an object`);
      return violations;
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) violations.push(`${at}.${required} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema !== undefined) {
        violations.push(...validateSchema(childSchema, child, path === "" ? key : `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        violations.push(`${at}.${key} is not allowed`);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      violations.push(`${at} must be an array`);
      return violations;
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        violations.push(...validateSchema(schema.items, entry, `${path}[${index}]`));
      });
    }
  } else if (schema.type === "string" && typeof value !== "string") {
    violations.push(`${at} must be a string`);
  } else if (schema.type === "integer" && !Number.isSafeInteger(value)) {
    violations.push(`${at} must be a safe integer`);
  } else if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    violations.push(`${at} must be a finite number`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    violations.push(`${at} must be a boolean`);
  }
  return violations;
}

export class UltraToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join("; ")}`);
    this.name = "UltraToolArgsError";
    this.code = "INVALID_ARGS";
    this.violations = violations;
  }
}

/**
 * Compile the small schema DSL used by this plugin into DSH's public raw tool
 * definition contract. The wrapper validates model arguments before calling
 * plugin code, while DSH ToolRuntime validates output. Keeping this adapter
 * local avoids importing the full host runtime and its service peers into a
 * standalone plugin tarball.
 */
export function defineUltraTool(options) {
  const parameters = {
    type: "object",
    additionalProperties: false,
    ...compileProperties(options.parameters)
  };
  const validateArguments = (args) => validateSchema(parameters, args);
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: compileSchema(options.output.schema),
      render: options.output.render
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    async execute(args, exec) {
      const violations = validateArguments(args);
      if (violations.length > 0) throw new UltraToolArgsError(violations);
      return options.execute(args, exec);
    }
  };
  if (options.isConcurrencySafe !== undefined) {
    tool.isConcurrencySafe = (args) => (
      validateArguments(args).length === 0 && options.isConcurrencySafe(args)
    );
  }
  return tool;
}
