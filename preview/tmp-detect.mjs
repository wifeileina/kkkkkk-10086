import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const root = '\\\\wsl.localhost\\Arch\\root\\TRSS_AllBot\\TRSS-Yunzai\\plugins\\kkkkkk-10086'
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files']
})
try {
  for (const name of ['xiaohongshu', 'douyin', 'bilibili']) {
    const src = path.join(root, `preview/${name}.html`)
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 })
    await page.goto('file://' + src, { waitUntil: 'load', timeout: 20000 })
    await new Promise(r => setTimeout(r, 800))
    const r = await page.evaluate(() => {
      const doc = document.documentElement
      const cont = document.querySelector('.container').getBoundingClientRect()
      const out = { docSW: doc.scrollWidth, docSH: doc.scrollHeight, contRight: cont.right, contBottom: cont.bottom }
      // 超宽元素
      const wide = []
      for (const el of document.querySelectorAll('*')) {
        const b = el.getBoundingClientRect()
        if (b.width > 20 && b.right > cont.right + 5) {
          wide.push({ tag: el.tagName, cls: (el.className && String(el.className)).slice(0, 40), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), bg: getComputedStyle(el).backgroundColor, op: getComputedStyle(el).opacity })
        }
        if (wide.length > 8) break
      }
      out.wide = wide
      // 底部最高的元素
      const bots = []
      for (const el of document.querySelectorAll('*')) {
        const b = el.getBoundingClientRect()
        if (b.height > 4 && b.bottom > cont.bottom - 30) {
          bots.push({ tag: el.tagName, cls: (el.className && String(el.className)).slice(0, 40), b: Math.round(b.bottom), h: Math.round(b.height), bg: getComputedStyle(el).backgroundColor })
        }
      }
      out.bots = bots.sort((A, B) => B.b - A.b).slice(0, 10)
      return out
    })
    console.log('\n===' + name + '===\n' + JSON.stringify(r, null, 1))
    await page.close()
  }
} finally { await browser.close() }