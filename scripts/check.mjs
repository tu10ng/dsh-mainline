/**
 * Static checks, run before the test suite (`npm run verify`).
 *
 * Syntax of every script, JSON that parses, one version in two places, no colour
 * literal in the panel (theme tokens only) and no machine-local home path in a
 * tracked text file.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.mainline'])
// Prototype and fixtures are captured material and may carry real paths.
const PATH_EXEMPT = ['scripts/check.mjs']
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt', '.html', '.css'])

const failures = []
const fail = (message) => failures.push(message)

/** @param {string} dir @returns {string[]} repo-relative posix paths */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(path.relative(ROOT, full).split(path.sep).join('/'))
  }
  return out
}

const files = walk(ROOT)
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')

for (const file of files.filter((f) => /\.(m?js)$/.test(f))) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' })
  if (result.status !== 0) fail(`${file}: syntax error\n${result.stderr.trim()}`)
}

for (const file of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(read(file))
  } catch (error) {
    fail(`${file}: invalid JSON (${error.message})`)
  }
}

if (existsSync(path.join(ROOT, 'package.json')) && existsSync(path.join(ROOT, 'lib/index.js'))) {
  const pkg = JSON.parse(read('package.json'))
  const match = /export\s+const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(read('lib/index.js'))
  if (!match) fail('lib/index.js: no `export const VERSION`')
  else if (match[1] !== pkg.version) fail(`version mismatch: package.json ${pkg.version} vs lib/index.js ${match[1]}`)
}

if (files.includes('lib/client.js')) {
  const lines = read('lib/client.js').split('\n')
  lines.forEach((line, i) => {
    if (/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z_-])|\brgba?\(/.test(line)) {
      fail(`lib/client.js:${i + 1}: colour literal (use var(--dsw-alias-*)): ${line.trim().slice(0, 80)}`)
    }
  })
}

const HOME_PATTERNS = [
  /[A-Za-z]:\Users\[^\\s"'<>]+/,
  /\/[a-z]\/Users\/[^/\s"'<>]+/i,
  /\/home\/[A-Za-z0-9_.-]+/,
  /\/Users\/[A-Za-z0-9_.-]+/,
]
for (const file of files) {
  if (!TEXT_EXT.has(path.extname(file)) || PATH_EXEMPT.some((p) => file.startsWith(p) || file === p)) continue
  read(file)
    .split('\n')
    .forEach((line, i) => {
      if (HOME_PATTERNS.some((re) => re.test(line))) fail(`${file}:${i + 1}: machine-local home path`)
    })
}

if (failures.length > 0) {
  console.error(`check failed (${failures.length}):\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`check ok (${files.length} files)`)
