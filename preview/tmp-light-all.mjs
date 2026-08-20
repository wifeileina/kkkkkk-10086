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
  for (const name of ['douyin', 'bilibili', 'xiaohongshu']) {
    const src = path.join(root, `preview/${name}.html`)
    let html = fs.readFileSync(src, 'utf8')
    html = html.replace('class="dark-mode"', 'class="light-mode"')
    const out = path.join(root, `preview/${name}-light.html`)
    fs.writeFileSync(out, html)
    const page = await browser.newPage()
    await page.setViewport({ width: 1240, height: 800, deviceScaleFactor: 1.5 })
    await page.goto('file://' + out, { waitUntil: 'load', timeout: 20000 })
    await new Promise(r => setTimeout(r, 800))
    await page.screenshot({ path: path.join(root, `preview/${name}-light.png`), fullPage: true })
    console.log('saved light', name)
    await page.close()
  }
} finally {
  await browser.close()
}
