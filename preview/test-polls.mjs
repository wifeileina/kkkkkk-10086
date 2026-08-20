const path = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs'
const mod = await import(path + '?t=' + Date.now())
const { xiaohongshuSign } = mod

const cookie = await xiaohongshuSign.createGuestCookie({ timeout: 20000 })
const a1 = xiaohongshuSign.extractA1FromCookie(cookie).trim()

const baseHeaders = {
  origin: 'https://www.xiaohongshu.com',
  referer: 'https://www.xiaohongshu.com/',
  cookie,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

async function post (url, body, isJsonBody) {
  const xt = xiaohongshuSign.generateXT()
  const xs = xiaohongshuSign.generateXSPost(url, a1, 'xhs-pc-web', body)
  const xsc = xiaohongshuSign.generateXSCommon(cookie)
  const b3 = xiaohongshuSign.generateXB3Traceid()
  const headers = {
    ...baseHeaders,
    'x-s': xs,
    'x-t': xt,
    'x-s-common': xsc,
    'x-b3-traceid': b3,
    'x-xray-traceid': b3,
    'content-type': 'application/json;charset=UTF-8'
  }
  const r = await fetch('https://edith.xiaohongshu.com' + url, {
    method: 'POST', headers, body: JSON.stringify(body)
  })
  const txt = await r.text()
  console.log('POST ' + url + ' => STATUS=' + r.status)
  console.log('  SETCOOKIE=' + JSON.stringify(r.headers.get('set-cookie')))
  console.log('  BODY=' + txt.slice(0, 700))
  return { r, txt }
}

async function main () {
  // create qrcode
  let r = await post('/api/sns/web/v1/login/qrcode/create', { qr_type: 1 })
  const d = JSON.parse(r.txt).data
  console.log('QR_ID=' + d.qr_id + ' CODE=' + d.code)

  // poll via /api/qrcode/userinfo (new-style)
  await post('/api/qrcode/userinfo', { qrId: d.qr_id, code: d.code })

  // also try legacy GET qrcode/status
  const xt = xiaohongshuSign.generateXT()
  const params = { qr_id: d.qr_id, code: d.code }
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const path2 = '/api/sns/web/v1/login/qrcode/status'
  const xs = xiaohongshuSign.generateXSGet(path2, a1, 'xhs-pc-web', params)
  const xsc = xiaohongshuSign.generateXSCommon(cookie)
  const b3 = xiaohongshuSign.generateXB3Traceid()
  const g = await fetch('https://edith.xiaohongshu.com' + path2 + '?' + qs, {
    headers: { ...baseHeaders, 'x-s': xs, 'x-t': xt, 'x-s-common': xsc, 'x-b3-traceid': b3 }
  })
  const gt = await g.text()
  console.log('GET qrcode/status => STATUS=' + g.status)
  console.log('  SETCOOKIE=' + JSON.stringify(g.headers.get('set-cookie')))
  console.log('  BODY=' + gt.slice(0, 700))
}
main().then(() => process.exit(0)).catch(e => { console.log('FATAL=' + e.message); process.exit(1) })