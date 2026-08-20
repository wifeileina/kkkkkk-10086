const fs = require('fs')
const p = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/config/config/cookies.yaml'
const s = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
const lines = s.split('\n')
const idx = lines.findIndex(l => /^\s*xiaohongshu:/.test(l))
const line = idx >= 0 ? lines[idx] : ''
const hasA1 = /(^|;\s*)a1=/i.test(line)
const segs = (line.match(/[a-zA-Z0-9_]+=/g) || [])
console.log('idx=' + idx + ' hasA1=' + hasA1 + ' cookieKeyCount=' + segs.length + ' keys=' + segs.join(','))