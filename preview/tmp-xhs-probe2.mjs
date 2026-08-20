import fs from 'node:fs'
const file = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs'
const src = fs.readFileSync(file, 'utf8')
const probe = (pat, before = 90, after = 160, max = 3) => {
  const out = []
  let idx = 0
  while (out.length < max) {
    const i = src.indexOf(pat, idx)
    if (i < 0) break
    out.push('…' + src.slice(Math.max(0, i - before), i + pat.length + after).replace(/\s+/g, ' ') + '…')
    idx = i + pat.length
  }
  return out
}
for (const kw of ['noteDetailMap', 'image_list', 'imageList', 'interact_info', 'interactInfo', 'note_card', 'media.stream', 'codecs']) {
  console.log('\n## ' + kw)
  console.log(probe(kw).join('\n--\n'))
}