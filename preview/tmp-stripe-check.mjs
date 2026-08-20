import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const root = '\\\\wsl.localhost\\Arch\\root\\TRSS_AllBot\\TRSS-Yunzai\\plugins\\kkkkkk-10086'
const tplDir = path.join(root, 'resources/template')
const coverPath = path.join(root, 'preview/cover2.jpg')
const coverData = `file://${coverPath}`
const read = (p, optional = false) => {
  try { return fs.readFileSync(path.join(tplDir, p), 'utf8') }
  catch { if (optional) return ''; throw new Error(p) }
}
const commonCss = read('extend/css/common.css')

// 直接复用现有 render-all 生成的完整 html 文件
const names = ['douyin', 'bilibili', 'xiaohongshu']
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files']
})

try {
  for (const name of names) {
    const src = path.join(root, `preview/${name}.html`)
    const page = await browser.newPage()
    await page.setViewport({ width: 1240, height: 800, deviceScaleFactor: 1.5 })
    await page.goto('file://' + src, { waitUntil: 'load', timeout: 20000 })
    await new Promise(r => setTimeout(r, 800))
    const m = await page.evaluate(() => {
      const c = document.querySelector('.container')?.getBoundingClientRect()
      return {
        docW: document.documentElement.scrollWidth,
        docH: document.documentElement.scrollHeight,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        contW: c?.width, contH: c?.height,
        contBg: c ? getComputedStyle(document.querySelector('.container')).backgroundColor : null,
        opColor: (function(){const el=document.querySelector('.op-layer');return el?getComputedStyle(el).display:null})()
      }
    })
    console.log(name, JSON.stringify(m))

    const w = m.contW || 1180
    // 底部条带（最底 100px）+ 右侧条带（最右 80px）
    await page.screenshot({ path: path.join(root, `preview/${name}-bottomstripe.png`), clip: { x: 0, y: Math.max(0, m.docH - 100), width: Math.min(w, m.docW), height: 100 } })
    await page.screenshot({ path: path.join(root, `preview/${name}-rightstripe.png`), clip: { x: Math.max(0, m.docW - 80), y: 0, width: 80, height: Math.min(600, m.docH) } })
    await page.close()
  }
} finally { await browser.close() }