import { has, isPlainObject, looseJsonParse } from './json.js';
import { alignArguments, coerceSchemaObject, shellQuote, validateArguments } from './schema.js';

// Tool calling: sanitising parsed calls
// ===========================================================================

function unwrapArguments(value, schema) {
  if (!isPlainObject(value)) return value;
  const properties = schema?.properties;
  for (const key of ['arguments', 'args', 'parameters', 'input']) {
    if (properties && has(properties, key)) continue;
    if (!has(value, key)) continue;

    let inner = value[key];
    if (typeof inner === 'string') {
      const parsed = looseJsonParse(inner);
      if (!parsed.ok) continue;
      inner = parsed.value;
    }
    if (!isPlainObject(inner)) continue;

    const rest = { ...value };
    delete rest[key];
    return { ...inner, ...rest };
  }
  return value;
}

// Aligns parameter names with the schema, coerces types, and folds
// workdir/cwd into the command for shell-like tools that lack that parameter.
export function sanitizeToolCalls(calls, tools) {
  if (!calls?.length) return [];
  const definitions = new Map((tools || []).map((tool) => [tool.name, tool.parameters || {}]));

  return calls.map((call) => {
    const schema = definitions.get(call.name) || {};
    const properties = schema.properties;
    let args = isPlainObject(call.arguments) ? call.arguments : {};
    args = unwrapArguments(args, schema);
    args = alignArguments(args, schema).args;
    args = coerceSchemaObject(args, schema);
    let changed = !isPlainObject(call.arguments) || JSON.stringify(args) !== call.argumentsText;

    if (properties?.command && !properties.workdir && !properties.cwd && !properties.directory) {
      for (const key of ['workdir', 'cwd', 'directory']) {
        if (!has(args, key)) continue;
        changed = true;
        const directory = args[key];
        args = { ...args };
        delete args[key];
        if (
          typeof directory === 'string' &&
          directory.trim() &&
          typeof args.command === 'string' &&
          !/^\s*cd\s/.test(args.command)
        ) {
          args.command = `cd ${shellQuote(directory.trim())} && ${args.command}`;
        }
        break;
      }
    }

    if (!changed) return call;
    return { ...call, arguments: args, argumentsText: JSON.stringify(args) };
  });
}

export function validateToolCalls(calls, tools) {
  const definitions = new Map((tools || []).map((tool) => [tool.name, tool.parameters || {}]));
  const results = [];
  (calls || []).forEach((call, index) => {
    const schema = definitions.get(call.name);
    if (!schema) return;
    const problems = validateArguments(call.arguments, schema);
    if (problems.length) results.push({ index, name: call.name, problems });
  });
  return results;
}

// ===========================================================================
