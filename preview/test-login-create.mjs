const path = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs'
const mod = await import(path + '?t=' + Date.now())
const { xiaohongshuSign } = mod

async function main () {
  // 1. 获取游客 cookie（含 a1）
  const cookie = await xiaohongshuSign.createGuestCookie({ timeout: 20000 })
  console.log('GUEST len=' + cookie.length)
  const a1 = xiaohongshuSign.extractA1FromCookie(cookie).trim()
  console.log('A1=' + a1.slice(0, 40))

  // 2. 生成签名头
  const xstime = xiaohongshuSign.generateXT()
  const xs = xiaohongshuSign.generateXSPost('/api/sns/web/v1/login/qrcode/create', a1, 'xhs-pc-web', { qr_type: 1 })
  const xsc = xiaohongshuSign.generateXSCommon(cookie)
  const b3 = xiaohongshuSign.generateXB3Traceid()
  console.log('XT=' + xstime)
  console.log('XS=' + xs.slice(0, 40))
  console.log('XSC=' + xsc.slice(0, 40))
  console.log('B3=' + b3)

  // 3. POST 创建二维码
  const headers = {
    'content-type': 'application/json;charset=UTF-8',
    origin: 'https://www.xiaohongshu.com',
    referer: 'https://www.xiaohongshu.com/',
    cookie,
    'x-s': xs,
    'x-t': xstime,
    'x-s-common': xsc,
    'x-b3-traceid': b3,
    'x-xray-traceid': b3,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  }
  try {
    const r = await fetch('https://edith.xiaohongshu.com/api/sns/web/v1/login/qrcode/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ qr_type: 1 })
    })
    const txt = await r.text()
    console.log('CREATE_STATUS=' + r.status)
    console.log('CREATE_SETCOOKIE=' + JSON.stringify(r.headers.get('set-cookie')))
    console.log('CREATE_BODY=' + txt.slice(0, 600))
  } catch (e) {
    console.log('CREATE_ERR=' + e.message)
  }
}
main().then(() => process.exit(0)).catch(e => { console.log('FATAL=' + e.message); process.exit(1) })