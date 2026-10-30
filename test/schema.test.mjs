/**
 * Tool schema contract: the Host accepts a small subset of JSON Schema and rejects the rest
 * at registration, quietly (the panel works, the model simply has no tools). This walker
 * mirrors the Host's validator; `type` must be a single string, nullability is `oneOf`.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { createTools } from '../lib/tools.js'
import { makeService } from './helpers/host-fakes.mjs'

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']
const CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment']
const ONE_OF_SIBLINGS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const REQUIRES_OBJECT = ['properties', 'required', 'additionalProperties']
const PRIMITIVE_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

function matchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  return typeof value === type
}

function collect(node, path, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.includes(key) && !ANNOTATION_KEYWORDS.includes(key)) out.push(`${path}.${key} is not a supported keyword`)
  }
  if (node.description !== undefined && typeof node.description !== 'string') out.push(`${path}.description must be a string`)
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(node, key)) out.push(`${path}.${key} requires type or oneOf`)
    return
  }
  if (hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(node, key)) out.push(`${path}.${key} is not supported beside oneOf`)
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      out.push(`${path}.oneOf must hold at least two schemas`)
      return
    }
    node.oneOf.forEach((branch, i) => collect(branch, `${path}.oneOf[${i}]`, out))
    return
  }
  const type = node.type
  if (typeof type !== 'string') {
    out.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }
  if (!SCHEMA_TYPES.includes(type)) {
    out.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }
  for (const key of REQUIRES_OBJECT) if (Object.hasOwn(node, key) && type !== 'object') out.push(`${path}.${key} requires type "object"`)
  if (Object.hasOwn(node, 'items') && type !== 'array') out.push(`${path}.items requires type "array"`)
  for (const key of ['enum', 'const']) {
    if (Object.hasOwn(node, key) && !PRIMITIVE_TYPES.includes(type)) out.push(`${path}.${key} requires a primitive type`)
  }
  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) out.push(`${path}.enum must not be empty`)
    for (const value of node.enum) {
      if (PRIMITIVE_TYPES.includes(type) && !matchesType(value, type)) out.push(`${path}.enum holds ${JSON.stringify(value)}, which is not a ${type}`)
    }
  }
  if (Object.hasOwn(node, 'const') && PRIMITIVE_TYPES.includes(type) && !matchesType(node.const, type)) out.push(`${path}.const does not match type ${type}`)
  if (type === 'object' && node.properties !== undefined) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) out.push(`${path}.properties must be an object`)
    else for (const [name, child] of Object.entries(node.properties)) collect(child, `${path}.properties.${name}`, out)
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) out.push(`${path}.required must be an array`)
    else {
      const known = node.properties === undefined ? [] : Object.keys(node.properties)
      for (const name of node.required) if (!known.includes(name)) out.push(`${path}.required names an undeclared property: ${name}`)
    }
  }
  if (type === 'array' && node.items !== undefined) collect(node.items, `${path}.items`, out)
}

const violationsOf = (schema) => {
  const out = []
  collect(schema, 'schema', out)
  return out
}

test('every tool schema stays inside the Host subset', () => {
  const tools = createTools({ service: makeService() })
  assert.equal(tools.length, 12)
  for (const tool of tools) {
    for (const [label, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
      const violations = violationsOf(schema)
      assert.deepEqual(violations, [], `${tool.name}.${label}: ${violations.join(' | ')}`)
    }
  }
})

test('the walker really detects the mistakes it guards against', () => {
  assert.match(violationsOf({ type: 'object', properties: { a: { type: ['string', 'null'] } } })[0], /type arrays/)
  assert.match(violationsOf({ type: ['string'], oneOf: [{ type: 'string' }] })[0], /both type and oneOf/)
  assert.match(violationsOf({ properties: {} })[0], /requires type or oneOf/)
  assert.match(violationsOf({ type: 'object', items: { type: 'string' } })[0], /items requires/)
  assert.match(violationsOf({ type: 'object', patternProperties: {} })[0], /not a supported keyword/)
  assert.match(violationsOf({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] })[0], /undeclared/)
  assert.deepEqual(violationsOf({ oneOf: [{ type: 'string' }, { type: 'null' }] }), [])
})
