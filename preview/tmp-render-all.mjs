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

const pages = {
  douyin: {
    html: `<!doctype html>
<html lang="zh-cn"><head><meta charset="utf-8"/>
<style>
body { margin:0; }
.op-layer{display:none;}
.container{ width:1180px; overflow:hidden; }
${commonCss}
${read('douyin/css/videoInfo.css')}
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
        <span class="hashtag">#赛博朋克</span><span class="hashtag">#游戏</span><span class="hashtag">#冬日限定</span>
      </div>
      <div class="subline">
        <span>2026-08-19</span><span>时长 03:24</span><span class="dy-id">7421658901234567</span>
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
  },
  bilibili: {
    html: `<!doctype html>
<html lang="zh-cn"><head><meta charset="utf-8"/>
<style>
body { margin:0; }
.op-layer{display:none;}
.container{ width:1440px; overflow:hidden; }
${commonCss}
${read('bilibili/css/videoInfo.css')}
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
      <div class="subline">
        <span>2026-08-19</span><span>123,456 播放</span><span>2,345 弹幕</span><span>321 评论</span>
        <span class="bvid">BV1xx411c7mD</span>
      </div>
      <section class="desc">这是一段视频简介，用于测试信息区的排版与氛围层透出效果。</section>
      <section class="stats-grid">
        <div><strong>123,456</strong><span>点赞</span></div>
        <div><strong>2,345</strong><span>投币</span></div>
        <div><strong>6,789</strong><span>收藏</span></div>
        <div><strong>321</strong><span>分享</span></div>
      </section>
      <footer class="footer">
        <div class="owner">
          <div class="avatar-wrap"><img class="avatar" src="${coverData}" alt="头像" /></div>
          <div>
            <div class="owner-name">小卡解析</div>
            <div class="owner-mid">UID: 123456789</div>
          </div>
        </div>
        <div class="qrcode-box"><div id="qrcode"></div><div class="qrcode-text">视频分享链接</div></div>
      </footer>
    </main>
  </div>
  <div class="copyright">小卡解析 ktxyAria</div>
</div>
</body></html>`
  },
  xiaohongshu: {
    html: `<!doctype html>
<html lang="zh-cn"><head><meta charset="utf-8"/>
<style>
body { margin:0; }
.op-layer{display:none;}
.container{ width:1180px; overflow:hidden; }
${commonCss}
${read('xiaohongshu/css/noteInfo.css')}
</style>
</head>
<body class="dark-mode">
<div class="container" id="container">
  <div class="xhs-note-page">
    <div class="ambient" aria-hidden="true"><img src="${coverData}" alt="" /></div>
    <section class="cover">
      <img src="${coverData}" alt="" />
      <div class="brand">小红书</div>
    </section>
    <main class="content">
      <div class="hashtags">
        <span class="hashtag">#赛博朋克</span><span class="hashtag">#游戏</span><span class="hashtag">#冬日限定</span>
      </div>
      <p class="desc">赛博女剑客的冬日限定企划，霓虹都市下的战斗少女。</p>
      <div class="meta">
        <span>2026-08-19</span><span>上海</span>
        <span class="note-id">ID 1234567890</span>
      </div>
      <section class="stats">
        <div><strong>123,456</strong><span>点赞</span></div>
        <div><strong>2,345</strong><span>评论</span></div>
        <div><strong>6,789</strong><span>收藏</span></div>
        <div><strong>321</strong><span>分享</span></div>
      </section>
      <footer>
        <section class="author">
          <img src="${coverData}" alt="" />
          <div>
            <div class="name">小卡解析</div>
            <div class="uid">1234567890</div>
          </div>
        </section>
        <section class="qrcode-box">
          <div id="qrcode"></div>
          <span>扫码查看原笔记</span>
        </section>
      </footer>
    </main>
  </div>
  <div class="copyright">小卡解析 ktxyAria</div>
</div>
</body></html>`
  }
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files']
})

try {
  for (const [name, cfg] of Object.entries(pages)) {
    const out = path.join(root, `preview/${name}.html`)
    fs.writeFileSync(out, cfg.html)
    const page = await browser.newPage()
    await page.setViewport({ width: 1240, height: 800, deviceScaleFactor: 1.5 })
    await page.goto('file://' + out, { waitUntil: 'load', timeout: 20000 })
    await new Promise(r => setTimeout(r, 800))
    await page.screenshot({ path: path.join(root, `preview/${name}.png`), fullPage: true })
    console.log('saved', name)
    await page.close()
  }
} finally {
  await browser.close()
}
