import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const root = '\\\\wsl.localhost\\Arch\\root\\TRSS_AllBot\\TRSS-Yunzai\\plugins\\kkkkkk-10086'
const tplDir = path.join(root, 'resources/template')
const coverPath = path.join(root, 'preview/cover2.jpg')

const read = (p, optional = false) => {
  try { return fs.readFileSync(path.join(tplDir, p), 'utf8') }
  catch { if (optional) return ''; throw new Error(p) }
}

const commonCss = read('extend/css/common.css')
const dyCss = read('douyin/css/videoInfo.css')
const coverData = `file://${coverPath}`

const html = `<!doctype html>
<html lang="zh-cn"><head><meta charset="utf-8"/>
<style>
body { margin:0; }
.op-layer{display:none;}
.container{ width:1180px; overflow:hidden; }
${commonCss}
${dyCss}
</style>
</head>
<body class="dark-mode">
<div class="container" id="container">
  <div class="video-info-page">
    <div class="ambient" aria-hidden="true"><img src="${coverData}" alt="" /></div>
    <div class="cover-wrap">
      <img class="cover" src="${coverData}" alt="封面" />
    </div>
    <main class="content">
      <div class="title-row"><h1>赛博女剑客 · 冬日限定</h1></div>
      <div class="hashtags">
        <span class="hashtag">#赛博朋克</span>
        <span class="hashtag">#游戏</span>
        <span class="hashtag">#冬日限定</span>
      </div>
      <div class="subline">
        <span>2026-08-19</span>
        <span>时长 03:24</span>
        <span class="dy-id">7421658901234567</span>
      </div>
      <section class="stats-grid">
        <div><strong>123,456</strong><span>点赞</span></div>
        <div><strong>2,345</strong><span>评论</span></div>
        <div><strong>6,789</strong><span>收藏</span></div>
        <div><strong>321</strong><span>分享</span></div>
      </section>
      <section class="music-box">
        <img class="music-cover" src="${coverData}" alt="" />
        <div class="music-text">
          <div class="music-title">♪ 霓虹心跳 (Remix)</div>
          <div class="music-author">电子鱼丸</div>
        </div>
      </section>
      <footer class="footer">
        <div class="owner">
          <img class="owner-avatar" src="${coverData}" alt="头像" />
          <div class="owner-text">
            <div class="owner-name">小卡解析</div>
            <div class="owner-id">抖音号：xiaoka0001</div>
            <div class="owner-stats">
              <span class="owner-stat"><i>粉丝</i><b>125.8万</b></span>
              <span class="owner-stat"><i>获赞</i><b>3019.6万</b></span>
            </div>
          </div>
        </div>
        <div class="brand">小卡解析 ktxyAria</div>
      </footer>
    </main>
  </div>
  <div class="copyright">小卡解析 ktxyAria</div>
</div>
</body></html>`

const out = path.join(root, 'preview/card.html')
fs.writeFileSync(out, html)

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
      return { top: r.top, bottom: r.bottom, height: r.height }
    }
    return {
      page: q('.video-info-page'),
      coverWrap: q('.cover-wrap'),
      cover: q('.cover'),
      content: q('.content'),
      title: q('.title-row'),
      stats: q('.stats-grid'),
      footer: q('.footer'),
      container: q('.container'),
      docH: document.documentElement.scrollHeight
    }
  })
  console.log(JSON.stringify(dims, null, 2))
} finally {
  await browser.close()
}
