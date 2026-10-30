// 用插件自己的解析器检查一个项目文件: 能否原样往返, id 是否唯一.
// 给了基线 (git 版本或 Windows 文件路径) 时, 再报删掉/新增的 id, 以及标题层 (父节点/种类/状态/?/标题) 变了几处.
// 用法: node check.mjs <项目.md> [基线]
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, basename } from 'node:path'

// 这个 skill 放在插件仓库的 skills/todo-mainline/ 下, 解析器在上两级.
const { parse, serialize } = await import(new URL('../../lib/format.js', import.meta.url).href)

const [file, base] = process.argv.slice(2)
if (!file) {
  console.error('用法: node check.mjs <项目.md> [git 版本 | 文件路径]')
  process.exit(2)
}
const name = basename(file)

function heads(text) {
  const out = new Map()
  const walk = (n, parent) => {
    out.set(n.id, [parent, n.kind, n.state, n.question ? '?' : '', n.title].join('|'))
    n.children.forEach(c => walk(c, n.id))
  }
  walk(parse(text, { file: name }), '')
  return out
}

function countIds(text) {
  const ids = []
  const walk = n => { ids.push(n.id); n.children.forEach(walk) }
  walk(parse(text, { file: name }))
  return ids
}

const now = readFileSync(file, 'utf8')
const roundTrip = serialize(parse(now, { file: name })) === now
const ids = countIds(now)
const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
console.log('往返一致:', roundTrip)
console.log(`节点 ${ids.length}, ${dup.length ? `重复 id: ${dup.join(' ')}` : 'id 唯一'}`)

let ok = roundTrip && !dup.length
if (base) {
  const old = existsSync(base)
    ? readFileSync(base, 'utf8')
    : execFileSync('git', ['-C', dirname(file), 'show', `${base}:./${name}`], { encoding: 'utf8' })
  const a = heads(old)
  const b = heads(now)
  const removed = [...a.keys()].filter(id => !b.has(id))
  const added = [...b.keys()].filter(id => !a.has(id))
  const changed = [...b.keys()].filter(id => a.has(id) && a.get(id) !== b.get(id))
  const order = JSON.stringify([...a.keys()].filter(id => b.has(id))) !== JSON.stringify([...b.keys()].filter(id => a.has(id)))
  console.log('删掉的 id:', removed.join(' ') || '无')
  console.log('新增的 id:', added.join(' ') || '无')
  console.log('标题层改动:', changed.length ? changed.join(' ') : '无', order ? '(顺序也变了)' : '')
  console.log(`字数 ${old.length} → ${now.length}`)
}
process.exit(ok ? 0 : 1)
