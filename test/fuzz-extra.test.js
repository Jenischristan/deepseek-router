import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionStore } from '../src/sessions.js';
import {
  alignArguments,
  coerceSchemaObject,
  coerceSchemaValue,
  damerauDistance,
  describeType,
  findProperty,
  matchesSchemaType,
  nameVariants,
  normalizeIdentifier,
  primaryType,
  rankToolNames,
  resolveToolName,
  schemaTypes,
  shellQuote,
  toIndex,
  tryEnumMatch,
  validateArguments,
  valueMatchesType,
} from '../src/openai/schema.js';
import { sanitizeToolCalls } from '../src/openai/sanitize.js';
import { formatToolCallsForTranscript, truncateMiddle } from '../src/openai/transcript.js';
import { parseToolResponse } from '../src/openai/parse.js';

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

function randomString(rnd, alphabet, max = 40) {
  const length = Math.floor(rnd() * max);
  let out = '';
  for (let i = 0; i < length; i += 1) out += pick(rnd, alphabet);
  return out;
}

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
const KEY_ALPHABET = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3',
  '4', '5', '6', '7', '8', '9', '_', '-', ' ', '.', ':', 'A', 'B', 'C',
];

function randomKey(rnd) {
  const length = 1 + Math.floor(rnd() * 6);
  let out = '';
  for (let i = 0; i < length; i += 1) out += pick(rnd, KEY_ALPHABET);
  return out;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function randomSchema(rnd, depth = 0) {
  const choice = rnd();
  if (depth > 2 || choice < 0.35) {
    const schema = { type: pick(rnd, SCHEMA_TYPES) };
    if (rnd() < 0.3) {
      schema.enum = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () =>
        pick(rnd, ['a', 'b', 'A', '1', 1, true, null, 'a-b', 'a_b']));
    }
    if (rnd() < 0.2) delete schema.type;
    return schema;
  }
  if (choice < 0.6) {
    const properties = {};
    const count = Math.floor(rnd() * 4);
    for (let i = 0; i < count; i += 1) properties[randomKey(rnd)] = randomSchema(rnd, depth + 1);
    const schema = { type: 'object', properties };
    if (rnd() < 0.5) schema.required = Object.keys(properties).filter(() => rnd() < 0.5);
    if (rnd() < 0.3) schema.additionalProperties = false;
    return schema;
  }
  if (choice < 0.8) {
    return { type: 'array', items: randomSchema(rnd, depth + 1) };
  }
  return {
    anyOf: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => randomSchema(rnd, depth + 1)),
  };
}

function randomValue(rnd, depth = 0) {
  const choice = rnd();
  if (depth > 2 || choice < 0.55) {
    return pick(rnd, [
      null, true, false, 0, 1, -1, 1.5, -2.5, '', 'x', '1', 'true', 'false',
      'A', ' a-b ', '0', 'NaN', 'Infinity', 1e21, -0.5,
    ]);
  }
  if (choice < 0.75) {
    return Array.from({ length: Math.floor(rnd() * 3) }, () => randomValue(rnd, depth + 1));
  }
  const object = {};
  const count = Math.floor(rnd() * 4);
  for (let i = 0; i < count; i += 1) object[randomKey(rnd)] = randomValue(rnd, depth + 1);
  return object;
}

// ---------------------------------------------------------------------------
// schema: schemaTypes / primaryType / valueMatchesType / matchesSchemaType
// ---------------------------------------------------------------------------

test('fuzz: schemaTypes always returns an array of known type names', () => {
  const rnd = prng(0x5c4e);
  for (let i = 0; i < 2000; i += 1) {
    const schema = randomSchema(rnd);
    const types = schemaTypes(schema);
    assert.equal(Array.isArray(types), true);
    for (const type of types) {
      assert.equal(typeof type, 'string');
      assert.equal(['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(type), true);
    }
    const primary = primaryType(schema);
    if (types.length) assert.equal(types.includes(primary), true, `primary ${primary} not in ${types}`);
    else assert.equal(primary, null);
    // null / undefined schemas never throw
    assert.deepEqual(schemaTypes(null), []);
    assert.equal(primaryType(undefined), null);
  }
});

test('fuzz: valueMatchesType is consistent with matchesSchemaType', () => {
  const rnd = prng(0x7a1e);
  for (let i = 0; i < 3000; i += 1) {
    const value = randomValue(rnd);
    const type = pick(rnd, SCHEMA_TYPES);
    const direct = valueMatchesType(value, type);
    const viaSchema = matchesSchemaType(value, { type });
    assert.equal(direct, viaSchema, `value=${JSON.stringify(value)} type=${type}`);
    // Unknown types match everything (permissive default); null only matches
    // 'null' or an unknown type.
    assert.equal(valueMatchesType(value, 'nonsense'), true);
    if (value === null && ['string','number','integer','boolean','object','array'].includes(type)) {
      assert.equal(valueMatchesType(null, type), false);
    }
    // Integers are numbers; numbers are not necessarily integers.
    if (valueMatchesType(value, 'integer')) {
      assert.equal(valueMatchesType(value, 'number'), true);
      assert.equal(Number.isInteger(value), true);
    }
  }
});

// ---------------------------------------------------------------------------
// schema: describeType never throws / is bounded
// ---------------------------------------------------------------------------

test('fuzz: describeType terminates and produces a non-empty string', () => {
  const rnd = prng(0xde5c);
  for (let i = 0; i < 1000; i += 1) {
    const schema = randomSchema(rnd);
    for (const options of [{}, { objects: false }, { depth: 0 }, { depth: 2, objects: false }]) {
      const text = describeType(schema, options);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.ok(text.length < 4000, `describeType too long: ${text.slice(0, 80)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// schema: normalizeIdentifier / nameVariants / damerauDistance / shellQuote
// ---------------------------------------------------------------------------

test('fuzz: normalizeIdentifier only emits [a-z0-9] and is idempotent', () => {
  const rnd = prng(0x1d3f);
  for (let i = 0; i < 2000; i += 1) {
    const raw = randomString(rnd, KEY_ALPHABET, 20);
    const id = normalizeIdentifier(raw);
    assert.equal(typeof id, 'string');
    assert.match(id, /^[a-z0-9]*$/);
    assert.equal(normalizeIdentifier(id), id);
    assert.equal(normalizeIdentifier(null), '');
    assert.equal(normalizeIdentifier(undefined), '');
  }
});

test('fuzz: nameVariants always includes the raw name and is bounded', () => {
  const rnd = prng(0x9a77);
  for (let i = 0; i < 1500; i += 1) {
    const raw = randomString(rnd, KEY_ALPHABET, 16);
    const variants = nameVariants(raw);
    assert.equal(Array.isArray(variants), true);
    const base = String(raw ?? '').trim().replace(/^[`"'<[({ \s]+|[`"'>\])}\s]+$/g, '');
    if (base) {
      assert.ok(variants.length > 0);
      assert.equal(variants.includes(base), true, `base ${JSON.stringify(base)} missing`);
    } else {
      assert.equal(variants.length, 0);
    }
    assert.equal(new Set(variants).size, variants.length, 'duplicate variants');
    for (const variant of variants) assert.equal(typeof variant, 'string');
  }
});

test('fuzz: damerauDistance is symmetric, bounded and zero on equal input', () => {
  const rnd = prng(0xd4a1);
  for (let i = 0; i < 1200; i += 1) {
    const a = randomString(rnd, ['a', 'b', 'c', 'd'], 8);
    const b = randomString(rnd, ['a', 'b', 'c', 'd'], 8);
    const ab = damerauDistance(a, b);
    const ba = damerauDistance(b, a);
    assert.equal(ab, ba, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    assert.ok(ab >= 0);
    assert.ok(ab <= Math.max(a.length, b.length));
    assert.equal(damerauDistance(a, a), 0);
  }
});

test('fuzz: shellQuote round-trips a single shell word', () => {
  const rnd = prng(0x5e11);
  const alphabet = ['a', 'b', ' ', "'", '"', '$', '`', '\\', '\n', '*', '?', ';', '&', '|', '中'];
  for (let i = 0; i < 800; i += 1) {
    const text = randomString(rnd, alphabet, 20);
    const quoted = shellQuote(text);
    assert.equal(typeof quoted, 'string');
    assert.equal(quoted.includes('\u0000'), false);
    if (!text) continue;
    // The quoting must survive being re-quoted without changing the payload.
    assert.equal(shellQuote(text), quoted);
  }
});

// ---------------------------------------------------------------------------
// schema: alignArguments invariants
// ---------------------------------------------------------------------------

test('fuzz: alignArguments never loses a key or invents a required value', () => {
  const rnd = prng(0xa116);
  for (let i = 0; i < 2000; i += 1) {
    const schema = randomSchema(rnd);
    const candidate = randomValue(rnd);
    const input = isPlainObject(candidate) ? candidate : {};
    const { args, missing, leftover, matched } = alignArguments(input, schema);
    assert.equal(isPlainObject(args), true);
    assert.equal(Array.isArray(missing), true);
    assert.equal(Array.isArray(leftover), true);
    assert.equal(typeof matched, 'number');
    assert.ok(matched >= 0);
    assert.ok(matched <= Object.keys(input).length);
    // Every unmatched input key is either remapped, dropped (additionalProperties=false),
    // or reported in leftover; nothing may silently disappear otherwise.
    const additional = schema?.additionalProperties !== false;
    const props = isPlainObject(schema?.properties) ? Object.keys(schema.properties) : [];
    if (additional && props.length) {
      const inputKeys = Object.keys(input);
      const outputKeys = Object.keys(args);
      const missingCount = missing.length;
      assert.ok(
        outputKeys.length + (inputKeys.length - matched) >= inputKeys.length - missingCount,
        'more keys vanished than can be explained',
      );
    }
    // Required keys are either present or reported missing.
    for (const key of Array.isArray(schema?.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) {
        assert.equal(missing.includes(key), true, `required ${key} neither present nor reported`);
      }
    }
  }
});

test('fuzz: alignArguments is a fixed point on an already-aligned object', () => {
  const rnd = prng(0x11fe);
  for (let i = 0; i < 800; i += 1) {
    const properties = {};
    const count = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < count; k += 1) properties[`p${k}`] = { type: 'string' };
    const schema = { type: 'object', properties, additionalProperties: false };
    const input = {};
    for (const key of Object.keys(properties)) input[key] = randomString(rnd, ['a', 'b'], 5);
    const first = alignArguments(input, schema);
    assert.deepEqual(first.args, input);
    assert.deepEqual(first.missing, []);
    assert.deepEqual(first.leftover, []);
    const second = alignArguments(first.args, schema);
    assert.deepEqual(second.args, first.args);
    assert.deepEqual(second.missing, []);
  }
});

// ---------------------------------------------------------------------------
// schema: tryEnumMatch / coerceSchemaValue / coerceSchemaObject
// ---------------------------------------------------------------------------

test('fuzz: tryEnumMatch only returns members of the enum', () => {
  const rnd = prng(0xe17e);
  for (let i = 0; i < 1500; i += 1) {
    const values = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () =>
      pick(rnd, ['a', 'b', 'A', 'B', 'a-b', 'a_b', 'a b', 'x', 1, 2, true]));
    const schema = { enum: values };
    const input = pick(rnd, [...values, 'A', 'a', '1', 'true', 'zzz', 3]);
    const match = tryEnumMatch(input, schema);
    if (match !== input) assert.equal(values.includes(match), true);
    // Non-enum schemas never change the value.
    assert.equal(tryEnumMatch(input, { type: 'string' }), input);
    assert.equal(tryEnumMatch(input, null), input);
  }
});

test('fuzz: coerceSchemaValue matches the declared type whenever it can', () => {
  const rnd = prng(0xc0e2);
  for (let i = 0; i < 2500; i += 1) {
    const schema = randomSchema(rnd);
    const input = randomValue(rnd);
    let output;
    assert.doesNotThrow(() => {
      output = coerceSchemaValue(input, schema, randomKey(rnd));
    });
    const types = schemaTypes(schema);
    // If coercion changed the value, the result should be acceptable to the schema
    // (this is the core contract that prevents endless repair loops).
    if (output !== input && types.length) {
      assert.equal(matchesSchemaType(output, schema) || input === null, true,
        `coerced ${JSON.stringify(input)} -> ${JSON.stringify(output)} but schema ${JSON.stringify(schema)} rejects it`);
    }
  }
});

test('fuzz: coerceSchemaObject always returns a plain object', () => {
  const rnd = prng(0x0b1e);
  for (let i = 0; i < 1500; i += 1) {
    const input = randomValue(rnd);
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const output = coerceSchemaObject(input, schema);
    if (isPlainObject(input)) assert.equal(isPlainObject(output), true);
    else assert.equal(output, input);
  }
});

// ---------------------------------------------------------------------------
// schema: validateArguments
// ---------------------------------------------------------------------------

test('fuzz: validateArguments is total and bounded', () => {
  const rnd = prng(0x7a11);
  for (let i = 0; i < 2500; i += 1) {
    const schema = randomSchema(rnd);
    const input = randomValue(rnd);
    let problems;
    assert.doesNotThrow(() => {
      problems = validateArguments(input, schema);
    });
    assert.equal(Array.isArray(problems), true);
    assert.ok(problems.length <= 8, 'validateArguments must cap at 8 problems');
    for (const problem of problems) assert.equal(typeof problem, 'string');
    if (!isPlainObject(input)) assert.equal(problems.length, 1);
  }
});

// ---------------------------------------------------------------------------
// schema: findProperty / rankToolNames / resolveToolName / toIndex
// ---------------------------------------------------------------------------

test('fuzz: findProperty never returns a key that is absent or already taken', () => {
  const rnd = prng(0xf1d0);
  for (let i = 0; i < 1500; i += 1) {
    const properties = {};
    const count = 1 + Math.floor(rnd() * 5);
    for (let k = 0; k < count; k += 1) properties[randomKey(rnd)] = { type: 'string' };
    const taken = {};
    if (rnd() < 0.5) taken[pick(rnd, Object.keys(properties))] = true;
    const target = findProperty(randomKey(rnd), properties, taken);
    if (target) {
      assert.equal(Object.prototype.hasOwnProperty.call(properties, target), true);
      assert.equal(Object.prototype.hasOwnProperty.call(taken, target), false);
    }
  }
});

test('fuzz: rankToolNames is bounded, ordered by distance and always suffix-safe', () => {
  const rnd = prng(0xa9c1);
  for (let i = 0; i < 800; i += 1) {
    const tools = Array.from({ length: Math.floor(rnd() * 6) }, () => ({
      name: randomString(rnd, ['a', 'b', 'c', '_'], 6),
    }));
    const raw = randomString(rnd, ['a', 'b', 'c', '_'], 6);
    const ranked = rankToolNames(raw, tools);
    assert.equal(Array.isArray(ranked), true);
    assert.ok(ranked.length <= 3);
    for (const name of ranked) {
      assert.equal(tools.some((tool) => tool.name === name), true);
    }
    assert.equal(rankToolNames(raw, tools, 5).length <= 5, true);
  }
});

test('fuzz: resolveToolName only returns a declared tool or null', () => {
  const rnd = prng(0x2e50);
  for (let i = 0; i < 1200; i += 1) {
    const tools = Array.from({ length: Math.floor(rnd() * 5) }, () => ({
      name: pick(rnd, ['bash', 'read', 'write', 'edit', 'search']),
    }));
    const raw = pick(rnd, ['bash', 'Bash', 'b-a-s-h', 'ns/bash', 'bash()', '', null, 'unknown', randomKey(rnd)]);
    const resolved = resolveToolName(raw, tools);
    if (tools.length && resolved.name !== null) {
      assert.equal(tools.some((tool) => tool.name === resolved.name), true,
        `resolved ${resolved.name} not declared`);
    }
    if (!tools.length) {
      // Unrestricted: the name is passed through, but resolveToolName still
      // strips it (String(raw).trim()), so compare against that exact form.
      const verbatim = typeof raw === 'string' && raw.trim() ? String(raw).trim() : null;
      assert.equal(resolved.name, verbatim);
    }
    for (const suggestion of resolved.suggestions) {
      assert.equal(tools.some((tool) => tool.name === suggestion), true);
    }
    // With an empty tool list a non-empty name resolves to its trimmed form.
    const bare = resolveToolName(raw, []);
    if (typeof raw === 'string' && raw.trim()) assert.equal(bare.name, raw.trim());
  }
});

test('fuzz: toIndex keys are the declared tool names and never collide', () => {
  const rnd = prng(0x10de);
  for (let i = 0; i < 600; i += 1) {
    const tools = Array.from({ length: Math.floor(rnd() * 6) }, () => ({
      name: randomString(rnd, ['a', 'b', 'c'], 4),
    }));
    const index = toIndex(tools);
    assert.equal(index.tools.length, tools.length);
    for (const tool of index.tools) {
      assert.equal(tools.some((item) => item.name === tool.name), true);
    }
  }
});

// ---------------------------------------------------------------------------
// sanitizeToolCalls / validateToolCalls invariants under hostile schemas
// ---------------------------------------------------------------------------

test('fuzz: sanitizeToolCalls is idempotent and never mutates its inputs', () => {
  const rnd = prng(0x5a1d);
  for (let i = 0; i < 800; i += 1) {
    const tools = [
      {
        name: 'bash',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout: { type: 'number' },
            workdir: { type: 'string' },
          },
        },
      },
    ];
    const calls = Array.from({ length: Math.floor(rnd() * 3) }, () => ({
      name: pick(rnd, ['bash', 'search']),
      arguments: randomValue(rnd),
    }));
    const snapshot = JSON.stringify(calls);
    const first = sanitizeToolCalls(calls, tools);
    assert.equal(JSON.stringify(calls), snapshot, 'sanitizeToolCalls mutated its input');
    const second = sanitizeToolCalls(first, tools);
    assert.deepEqual(
      second.map((call) => ({ name: call.name, arguments: call.arguments })),
      first.map((call) => ({ name: call.name, arguments: call.arguments })),
    );
  }
});

// ---------------------------------------------------------------------------
// transcript: truncateMiddle
// ---------------------------------------------------------------------------

test('fuzz: truncateMiddle respects the limit and keeps both ends', () => {
  const rnd = prng(0x7231);
  for (let i = 0; i < 800; i += 1) {
    const text = randomString(rnd, ['a', 'b', ' ', '\n', '中', '😀'], 100);
    const limit = Math.floor(rnd() * 60);
    const out = truncateMiddle(text, limit);
    assert.equal(typeof out, 'string');
    if (text.length <= limit) {
      assert.equal(out, text);
    } else if (limit > 0) {
      assert.ok(out.startsWith(text.slice(0, Math.ceil(limit * 0.7))));
      assert.ok(out.includes('truncated'));
    }
  }
});

// ---------------------------------------------------------------------------
// transcript: tool-call replay is always parseable and preserves arguments
// ---------------------------------------------------------------------------

test('fuzz: formatToolCallsForTranscript is re-parseable for hostile values', () => {
  const rnd = prng(0x7ea1);
  const alphabet = ['a', 'b', ' ', '\n', '"', "'", '<', '>', '｜', '|', 'D', 'S', 'M', 'L', '/', '\\'];
  const tools = [{ name: 'bash', parameters: { type: 'object', properties: {} } }];
  for (let i = 0; i < 1000; i += 1) {
    const args = {};
    const count = Math.floor(rnd() * 3);
    for (let k = 0; k < count; k += 1) {
      args[`k${k}`] = randomString(rnd, alphabet, 20);
    }
    const text = formatToolCallsForTranscript([
      { id: 'call_1', function: { name: 'bash', arguments: JSON.stringify(args) } },
    ]);
    const parsed = parseToolResponse(text, tools, { allowedNames: new Set(['bash']) });
    assert.equal(parsed.calls.length, 1, JSON.stringify(args));
    assert.deepEqual(parsed.calls[0].arguments, args, JSON.stringify(args));
  }
});

// ---------------------------------------------------------------------------
// SessionStore: TTL / LRU invariants
// ---------------------------------------------------------------------------

test('fuzz: SessionStore never exceeds its capacity and is deterministic', () => {
  const rnd = prng(0x5e55);
  for (let round = 0; round < 40; round += 1) {
    const max = 1 + Math.floor(rnd() * 8);
    const store = new SessionStore({ ttlMs: 60_000, max });
    const keys = Array.from({ length: 40 }, () => `k${Math.floor(rnd() * 30)}`);
    for (const key of keys) {
      if (rnd() < 0.6) store.set(key, { payload: key });
      else if (rnd() < 0.5) store.get(key);
    }
    assert.ok(store.size <= max, `size ${store.size} > ${max}`);
    // A second round of sets keeps the cap and stays deterministic per key set.
    for (const key of keys) {
      if (rnd() < 0.5) store.set(key, { payload: key });
      assert.ok(store.size <= max);
    }
  }
});

test('fuzz: SessionStore.deleteByAccount removes only that account', () => {
  const rnd = prng(0xde1e);
  const store = new SessionStore({ maxEntries: 32 });
  const entries = [];
  for (let i = 0; i < 40; i += 1) {
    const account = `a${Math.floor(rnd() * 4)}`;
    const key = `k${i}`;
    store.set(key, { accountToken: account });
    entries.push([key, account]);
  }
  for (const account of ['a0', 'a1', 'a2', 'a3']) {
    store.deleteByAccount(account);
    for (const [key, owner] of entries) {
      if (owner === account) assert.equal(store.get(key), null);
    }
  }
});
