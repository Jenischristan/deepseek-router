import { has, isPlainObject, looseJsonParse } from './json.js';

// Tool calling: schema helpers, argument alignment, tool-name resolution
// ===========================================================================

export function normalizeIdentifier(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function schemaTypes(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const raw = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return raw.filter((item) => typeof item === 'string');
}

export function primaryType(schema) {
  const types = schemaTypes(schema);
  return types.find((item) => item !== 'null') || types[0] || null;
}

export function valueMatchesType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

export function matchesSchemaType(value, schema) {
  const types = schemaTypes(schema);
  if (!types.length) return true;
  return types.some((type) => valueMatchesType(value, type));
}

export function describeType(schema, { objects = true, depth = 0 } = {}) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.map((item) => JSON.stringify(item)).join(' | ');
  }
  if (has(schema, 'const')) return JSON.stringify(schema.const);
  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants) && variants.length) {
    return variants.map((item) => describeType(item, { objects, depth })).join(' | ');
  }
  const types = schemaTypes(schema);
  if (!types.length) return 'any';
  return types
    .map((type) => {
      if (type === 'array') {
        const inner = describeType(schema.items, { objects, depth: depth + 1 });
        return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
      }
      if (type === 'object') {
        const props = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
        if (!objects || depth >= 2 || !props.length) return 'object';
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const fields = props.map(
          (key) =>
            `${key}${required.has(key) ? '' : '?'}: ${describeType(schema.properties[key], {
              objects,
              depth: depth + 1,
            })}`,
        );
        return `{ ${fields.join('; ')} }`;
      }
      return type;
    })
    .join(' | ');
}

// Groups of parameter names that models routinely swap. Normalised form only.
const PARAM_ALIAS_GROUPS = [
  ['path', 'filepath', 'file', 'filename', 'targetfile', 'abspath', 'absolutepath', 'fullpath', 'filelocation'],
  ['path', 'dir', 'directory', 'folder', 'cwd', 'workdir', 'workingdirectory', 'dirpath', 'rootdir', 'basepath'],
  ['command', 'cmd', 'shellcommand', 'bashcommand', 'script', 'commandline', 'terminalcommand'],
  ['content', 'contents', 'text', 'filetext', 'filecontent', 'filecontents', 'data', 'body', 'newcontent'],
  ['oldstring', 'oldstr', 'oldtext', 'oldcontent', 'search', 'find', 'original'],
  ['newstring', 'newstr', 'newtext', 'newcontent', 'replace', 'replacement', 'replacewith'],
  ['pattern', 'query', 'regex', 'search', 'q', 'keyword', 'keywords', 'searchterm', 'expression'],
  ['url', 'uri', 'link', 'href'],
  ['timeout', 'timeoutms', 'timeoutseconds', 'timelimit'],
  ['limit', 'maxresults', 'numresults', 'topk'],
  ['description', 'desc', 'summary', 'explanation', 'reason', 'purpose'],
  ['glob', 'include', 'includepattern', 'filepattern'],
];

export function findProperty(key, properties, taken) {
  const normalized = normalizeIdentifier(key);
  const free = Object.keys(properties).filter((name) => !has(taken, name));
  const direct = free.filter((name) => normalizeIdentifier(name) === normalized);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;
  for (const group of PARAM_ALIAS_GROUPS) {
    if (!group.includes(normalized)) continue;
    const candidates = free.filter((name) => group.includes(normalizeIdentifier(name)));
    if (candidates.length === 1) return candidates[0];
  }
  return null;
}

// Maps the argument names a model used onto the names the schema declares.
// `guess` enables the "one unknown argument + one missing parameter" repair; it
// must be off when the alignment is only used to decide WHICH tool a call is for.
export function alignArguments(args, schema, { guess = true } = {}) {
  const input = isPlainObject(args) ? args : {};
  const properties = isPlainObject(schema?.properties) ? schema.properties : null;
  const required = Array.isArray(schema?.required) ? schema.required : [];

  if (!properties || !Object.keys(properties).length) {
    return {
      args: { ...input },
      missing: required.filter((key) => !has(input, key)),
      leftover: [],
      matched: Object.keys(input).length,
    };
  }

  const output = {};
  const pending = [];
  let matched = 0;

  for (const [key, value] of Object.entries(input)) {
    if (has(properties, key)) {
      output[key] = value;
      matched += 1;
    } else {
      pending.push([key, value]);
    }
  }

  let leftover = [];
  for (const [key, value] of pending) {
    const target = findProperty(key, properties, output);
    if (target) {
      output[target] = value;
      matched += 1;
    } else {
      leftover.push([key, value]);
    }
  }

  let missing = required.filter((key) => !has(output, key));

  // One unknown argument and exactly one missing required parameter of a
  // compatible type: the model just mis-named it.
  if (
    guess &&
    leftover.length === 1 &&
    missing.length === 1 &&
    matchesSchemaType(leftover[0][1], properties[missing[0]])
  ) {
    output[missing[0]] = leftover[0][1];
    leftover = [];
    matched += 1;
    missing = [];
  }

  if (schema.additionalProperties !== false) {
    for (const [key, value] of leftover) output[key] = value;
  }

  return { args: output, missing, leftover: leftover.map(([key]) => key), matched };
}

export function tryEnumMatch(value, schema) {
  if (typeof value !== 'string' || !Array.isArray(schema?.enum)) return value;
  if (schema.enum.includes(value)) return value;
  const wanted = normalizeIdentifier(value);
  const hits = schema.enum.filter(
    (item) => typeof item === 'string' && normalizeIdentifier(item) === wanted,
  );
  return hits.length === 1 ? hits[0] : value;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellWord(value) {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : shellQuote(text);
}

const COMMAND_KEY_RE = /^(?:command|cmd|shell_?command|bash_?command|script)$/i;
const TEXT_KEY_RE =
  /^(?:content|contents|text|body|data|prompt|message|old_?string|new_?string|old_?str|new_?str|file_?text)$/i;

export function coerceSchemaValue(value, schema, key = '') {
  if (value == null || !schema || typeof schema !== 'object') return value;
  const types = schemaTypes(schema);
  if (!types.length) return value;
  if (types.some((type) => valueMatchesType(value, type))) {
    // Already acceptable; still descend into containers and enums.
    if (Array.isArray(value) && schema.items) {
      return value.map((item) => coerceSchemaValue(item, schema.items));
    }
    if (isPlainObject(value) && types.includes('object')) return coerceSchemaObject(value, schema);
    return tryEnumMatch(value, schema);
  }

  const type = primaryType(schema);

  if (type === 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (
      Array.isArray(value) &&
      value.length &&
      value.every((item) => typeof item === 'string' || typeof item === 'number')
    ) {
      // argv-style ["ls","-la"] where a shell string is expected
      if (COMMAND_KEY_RE.test(key)) return value.map(shellWord).join(' ');
      if (TEXT_KEY_RE.test(key)) return value.join('\n');
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  if (type === 'integer' || type === 'number') {
    if (typeof value === 'string' && value.trim() !== '') {
      const number = Number(value);
      if (Number.isFinite(number)) return type === 'integer' ? Math.trunc(number) : number;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (type === 'integer' && typeof value === 'number' && Number.isFinite(value)) {
      return Math.round(value);
    }
    return value;
  }

  if (type === 'boolean') {
    if (typeof value === 'string') {
      const lower = value.trim().toLowerCase();
      if (lower === 'true' || lower === 'yes' || lower === '1') return true;
      if (lower === 'false' || lower === 'no' || lower === '0') return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }

  if (type === 'object') {
    if (typeof value === 'string') {
      const parsed = looseJsonParse(value);
      if (parsed.ok && isPlainObject(parsed.value)) return coerceSchemaObject(parsed.value, schema);
    }
    return value;
  }

  if (type === 'array') {
    if (typeof value === 'string') {
      const parsed = looseJsonParse(value);
      if (parsed.ok && Array.isArray(parsed.value)) {
        return schema.items
          ? parsed.value.map((item) => coerceSchemaValue(item, schema.items))
          : parsed.value;
      }
    }
    // A single scalar/object where a list is expected.
    return schema.items ? [coerceSchemaValue(value, schema.items)] : [value];
  }

  if (type === 'null' && value === 'null') return null;
  return value;
}

export function coerceSchemaObject(value, schema) {
  if (!isPlainObject(value)) return value;
  const properties = schema?.properties;
  if (!isPlainObject(properties)) return value;
  const output = { ...value };
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!has(output, key)) continue;
    output[key] = coerceSchemaValue(output[key], propertySchema, key);
  }
  return output;
}

export function describeValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function validateArguments(args, schema, { path = '', depth = 0 } = {}) {
  const problems = [];
  const label = (key) => (path ? `${path}.${key}` : key);

  if (!isPlainObject(args)) {
    problems.push(`${path || 'arguments'} must be a JSON object`);
    return problems;
  }
  if (!schema || typeof schema !== 'object') return problems;

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!has(args, key) || args[key] === undefined || args[key] === null) {
      problems.push(`missing required parameter "${label(key)}"`);
    }
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(args)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === false && Object.keys(properties).length) {
        problems.push(`unknown parameter "${label(key)}"`);
      }
      continue;
    }
    if (value === undefined || value === null) continue;

    if (!matchesSchemaType(value, propertySchema)) {
      problems.push(
        `parameter "${label(key)}" must be ${describeType(propertySchema, { objects: false })} ` +
          `but got ${describeValueType(value)}`,
      );
      continue;
    }
    if (Array.isArray(propertySchema.enum) && !propertySchema.enum.includes(value)) {
      problems.push(
        `parameter "${label(key)}" must be one of ${propertySchema.enum
          .map((item) => JSON.stringify(item))
          .join(', ')}`,
      );
      continue;
    }
    if (depth < 2) {
      if (isPlainObject(value) && schemaTypes(propertySchema).includes('object')) {
        problems.push(
          ...validateArguments(value, propertySchema, { path: label(key), depth: depth + 1 }),
        );
      } else if (Array.isArray(value) && isPlainObject(propertySchema.items)) {
        value.slice(0, 20).forEach((item, itemIndex) => {
          if (isPlainObject(item) && schemaTypes(propertySchema.items).includes('object')) {
            problems.push(
              ...validateArguments(item, propertySchema.items, {
                path: `${label(key)}[${itemIndex}]`,
                depth: depth + 1,
              }),
            );
          } else if (!matchesSchemaType(item, propertySchema.items)) {
            problems.push(
              `parameter "${label(key)}[${itemIndex}]" must be ${describeType(
                propertySchema.items,
                { objects: false },
              )} but got ${describeValueType(item)}`,
            );
          }
        });
      }
    }
  }

  return problems.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Tool name resolution
// ---------------------------------------------------------------------------

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

class ToolIndex {
  constructor(tools) {
    this.tools = (tools || []).filter((tool) => tool && typeof tool.name === 'string');
    this.byName = new Map(this.tools.map((tool) => [tool.name, tool]));
    this.byLower = groupBy(this.tools, (tool) => tool.name.toLowerCase());
    this.byNormalized = groupBy(this.tools, (tool) => normalizeIdentifier(tool.name));
  }
}

const indexCache = new WeakMap();
export function toIndex(tools) {
  if (tools instanceof ToolIndex) return tools;
  const list = Array.isArray(tools) ? tools : [];
  let index = indexCache.get(list);
  if (!index) {
    index = new ToolIndex(list);
    indexCache.set(list, index);
  }
  return index;
}

// Concepts models name differently from the client. A synonym match is only
// accepted when the arguments also fit the target tool's schema.
const TOOL_SYNONYM_GROUPS = [
  ['bash', 'shell', 'sh', 'zsh', 'terminal', 'runcommand', 'executecommand', 'runterminalcommand',
    'executebash', 'runbash', 'runshell', 'execshell', 'exec', 'cmd', 'powershell', 'runshellcommand'],
  ['read', 'readfile', 'viewfile', 'openfile', 'fileread', 'cat', 'view', 'getfile', 'readfilecontent'],
  ['write', 'writefile', 'createfile', 'filewrite', 'writetofile', 'savefile', 'overwritefile'],
  ['edit', 'editfile', 'strreplace', 'strreplaceeditor', 'strreplacebasedittool', 'replaceinfile',
    'modifyfile', 'updatefile', 'patchfile', 'replace'],
  ['grep', 'search', 'searchfiles', 'searchcode', 'findinfiles', 'ripgrep', 'rg', 'codesearch', 'greptool'],
  ['glob', 'find', 'findfiles', 'filesearch', 'globfiles'],
  ['ls', 'list', 'listdir', 'listdirectory', 'listfiles', 'readdir', 'dir', 'tree'],
  ['webfetch', 'fetch', 'fetchurl', 'httpget', 'geturl', 'openurl', 'browse', 'readurl', 'fetchpage'],
  ['websearch', 'searchweb', 'internetsearch', 'google', 'bingsearch', 'searchinternet'],
  ['todowrite', 'todo', 'todos', 'updatetodos', 'writetodos', 'tasklist'],
  ['task', 'subagent', 'agent', 'delegate', 'spawnagent', 'runagent'],
];

export function nameVariants(raw) {
  const variants = [];
  const add = (value) => {
    const text = String(value ?? '').trim();
    if (text && !variants.includes(text)) variants.push(text);
  };
  const strip = (value) => {
    let text = String(value ?? '').trim();
    text = text.replace(/^[`"'<\[({\s]+|[`"'>\])}\s]+$/g, '');
    text = text.replace(/\(\s*\)$/, '');
    return text.replace(/^[`"'<\[({\s]+|[`"'>\])}\s]+$/g, '').trim();
  };

  const base = strip(raw);
  add(base);
  // "bash(ls -la)" / "Read(file_path)": a call written like a function expression.
  add(base.replace(/\s*\([\s\S]*\)\s*$/, ''));
  add(base.replace(/^(?:functions?|tools?|default_api|multi_tool_use|function_calls?|assistant|api)\s*[.:/]\s*/i, ''));

  const segments = base.split(/__|[.:/]/).filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    add(segments.slice(index).join('__'));
    add(segments.slice(index).join('_'));
    add(segments.slice(index).join('.'));
  }
  if (segments.length > 1) add(segments[segments.length - 1]);
  return variants;
}

export function damerauDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

export function argsFitTool(args, tool) {
  if (!isPlainObject(args)) return true;
  const schema = tool.parameters || {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const aligned = alignArguments(args, schema, { guess: false });
  if (aligned.missing.length) return false;
  const keys = Object.keys(args);
  if (!keys.length || !Object.keys(properties).length) return true;
  return aligned.matched > 0;
}

export function rankToolNames(raw, tools, limit = 3) {
  const index = toIndex(tools);
  const wanted = normalizeIdentifier(nameVariants(raw).at(-1) || raw);
  if (!wanted) return [];
  const group = TOOL_SYNONYM_GROUPS.find((items) => items.includes(wanted));
  return index.tools
    .map((tool) => {
      const normalized = normalizeIdentifier(tool.name);
      const longest = Math.max(wanted.length, normalized.length) || 1;
      let score = 1 - damerauDistance(wanted, normalized) / longest;
      if (normalized.includes(wanted) || wanted.includes(normalized)) score += 0.3;
      if (group && group.includes(normalized)) score += 0.3;
      return { name: tool.name, score };
    })
    .filter((item) => item.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.name);
}

// Resolves whatever name the model wrote to a real tool name.
//   strict=true  -> only exact / cleaned / case-insensitive / normalised matches
//   strict=false -> also suffix, synonym and typo matches, gated on `args`
export function resolveToolName(raw, toolsOrIndex, { args, strict = false } = {}) {
  const index = toIndex(toolsOrIndex);
  const original = String(raw ?? '').trim();
  if (!index.tools.length) {
    return { name: original || null, how: 'unrestricted', suggestions: [] };
  }
  if (!original) return { name: null, how: null, suggestions: [] };

  const variants = nameVariants(original);

  for (const variant of variants) {
    if (index.byName.has(variant)) {
      return { name: variant, how: variant === original ? 'exact' : 'cleaned', suggestions: [] };
    }
  }
  for (const variant of variants) {
    const hits = index.byLower.get(variant.toLowerCase());
    if (hits?.length === 1) return { name: hits[0].name, how: 'case', suggestions: [] };
  }
  for (const variant of variants) {
    const normalized = normalizeIdentifier(variant);
    if (!normalized) continue;
    const hits = index.byNormalized.get(normalized);
    if (hits?.length === 1) return { name: hits[0].name, how: 'normalized', suggestions: [] };
  }

  const miss = () => ({ name: null, how: null, suggestions: rankToolNames(original, index) });
  if (strict) return miss();

  const unique = (candidates) => (candidates.length === 1 ? candidates[0] : null);
  const fits = (tool) => argsFitTool(args, tool);
  const wanted = normalizeIdentifier(variants[0]);
  if (!wanted) return miss();

  // Namespace noise: "mcp__server__read_file" vs "read_file" (either direction).
  const suffixHits = index.tools.filter((tool) => {
    const normalized = normalizeIdentifier(tool.name);
    if (normalized === wanted) return false;
    const longEnough = Math.min(normalized.length, wanted.length) >= 4;
    return (
      longEnough && (wanted.endsWith(normalized) || normalized.endsWith(wanted)) && fits(tool)
    );
  });
  const bySuffix = unique(suffixHits);
  if (bySuffix) return { name: bySuffix.name, how: 'suffix', suggestions: [] };

  // Same concept, different word: "execute_bash" -> "bash".
  const groups = TOOL_SYNONYM_GROUPS.filter((items) => items.includes(wanted));
  if (groups.length) {
    const synonymHits = index.tools.filter(
      (tool) =>
        groups.some((items) => items.includes(normalizeIdentifier(tool.name))) && fits(tool),
    );
    const bySynonym = unique(synonymHits);
    if (bySynonym) return { name: bySynonym.name, how: 'synonym', suggestions: [] };
  }

  // Typos: "raed_file" -> "read_file".
  if (wanted.length >= 4) {
    const threshold = Math.max(1, Math.floor(wanted.length * 0.25));
    const scored = index.tools
      .map((tool) => ({
        tool,
        distance: damerauDistance(wanted, normalizeIdentifier(tool.name)),
      }))
      .filter((item) => item.distance <= threshold && fits(item.tool))
      .sort((a, b) => a.distance - b.distance);
    if (scored.length && (scored.length === 1 || scored[1].distance > scored[0].distance)) {
      return { name: scored[0].tool.name, how: 'fuzzy', suggestions: [] };
    }
  }

  return miss();
}
// ===========================================================================
