import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const root = '\\\\wsl.localhost\\Arch\\root\\TRSS_AllBot\\TRSS-Yunzai\\plugins\\kkkkkk-10086'
const out = path.join(root, 'preview/card.html')

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1240, height: 800, deviceScaleFactor: 1.5 })
  await page.goto('file://' + out, { waitUntil: 'load', timeout: 20000 })
  await new Promise(r => setTimeout(r, 800))

  const dims = await page.evaluate(() => {
    const q = (s) => {
      const el = document.querySelector(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height, width: r.width }
    }
    return {
      page: q('.video-info-page'),
      cover: q('.cover'),
      content: q('.content'),
      title: q('.title-row'),
      docH: document.documentElement.scrollHeight
    }
  })
  console.log('dims', JSON.stringify(dims))

  const H = dims.page.height
  const bands = [
    { name: 'band_top', top: 0, height: H * 0.5 },
    { name: 'band_transition', top: H * 0.5, height: H * 0.12 },
    { name: 'band_mid', top: H * 0.62, height: H * 0.18 },
    { name: 'band_bottom', top: H * 0.8, height: H * 0.2 }
  ]

  for (const b of bands) {
    await page.screenshot({
      path: path.join(root, `preview/${b.name}.png`),
      clip: { x: 0, y: b.top, width: dims.page.width, height: b.height }
    })
    console.log('saved', b.name)
  }
} finally {
  await browser.close()
}
