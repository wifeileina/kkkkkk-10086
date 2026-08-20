import fs from 'node:fs'
const p = '\\\\wsl.localhost\\Arch\\root\\TRSS_AllBot\\TRSS-Yunzai\\plugins\\kkkkkk-10086\\resources\\template\\extend\\css\\common.css'
try {
  const c = fs.readFileSync(p, 'utf8')
  console.log('OK', c.length)
} catch (e) {
  console.log('ERR', e.message)
}
