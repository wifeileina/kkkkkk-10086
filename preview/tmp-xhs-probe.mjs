import fs from 'node:fs'

const file = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs'
const src = fs.readFileSync(file, 'utf8')

const around = (pattern, before = 150, after = 250, max = 6) => {
  const res = []
  let idx = 0
  while (res.length < max) {
    const i = src.indexOf(pattern, idx)
    if (i < 0) break
    res.push('…' + src.slice(Math.max(0, i - before), i + pattern.length + after).replace(/\s+/g, ' ') + '…')
    idx = i + pattern.length
  }
  return res
}

console.log('===== discovery/item =====')
console.log(around('discovery/item').join('\n---\n'))
console.log('\n===== __INITIAL_STATE__ =====')
console.log(around('__INITIAL_STATE__', 120, 180, 4).join('\n---\n'))
console.log('\n===== fetchNoteDetail =====')
console.log(around('fetchNoteDetail', 200, 400, 3).join('\n---\n'))
console.log('\n===== /discovery/item url build =====')
console.log(around('item/', 80, 120, 3).join('\n---\n'))

console.log('\n===== fetchXiaohongshuInternal =====')
console.log(around('fetchXiaohongshuInternal', 260, 500, 4).join('\n---\n'))

console.log('\n===== base URLs =====')
console.log([...src.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}[a-z0-9/_.-]*/g)].map(m => m[0]).filter(u => !u.includes('github') && !u.includes('w3.org') && !u.includes('example.com')).slice(0, 30).join('\n'))