import { Common, Config, Render } from '../../utils/index.js'
import { xiaohongshuSign } from '@ikenxuan/amagi'

const BASE = 'https://edith.xiaohongshu.com'
const LOGIN_PLATFORM = 'xhs-pc-web'
const QRCREATE_PATH = '/api/sns/web/v1/login/qrcode/create'
const QRPOLL_PATH = '/api/qrcode/userinfo'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const getMessageId = (msg) => msg?.message_id || msg?.messageId

const buildHeaders = (cookie, xs, xt) => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Content-Type': 'application/json;charset=UTF-8',
  Origin: 'https://www.xiaohongshu.com',
  Referer: 'https://www.xiaohongshu.com',
  'x-s': xs,
  'x-t': String(xt),
  Cookie: cookie
})

/**
 * 创建小红书扫码登录二维码
 */
async function createQrcode (a1, guestCookie) {
  const xs = xiaohongshuSign.generateXSPost(QRCREATE_PATH, a1, LOGIN_PLATFORM, { qr_type: 1 })
  const xt = xiaohongshuSign.generateXT()
  const resp = await fetch(`${BASE}${QRCREATE_PATH}`, {
    method: 'POST',
    headers: buildHeaders(guestCookie, xs, xt),
    body: JSON.stringify({ qr_type: 1 })
  })
  const json = await resp.json().catch(() => null)
  const data = json?.data
  if (!data?.url) throw new Error(json?.message || '生成二维码失败')
  return data // { code, url, qr_id, ... }
}

/**
 * 轮询二维码扫码状态
 * 返回: { status: 'wait'|'scanned'|'success'|'error', loginInfo, setCookie, message }
 */
async function pollQrcode (qr, a1, guestCookie) {
  const xs = xiaohongshuSign.generateXSPost(QRPOLL_PATH, a1, LOGIN_PLATFORM, {
    qrId: qr.qr_id,
    code: qr.code
  })
  const xt = xiaohongshuSign.generateXT()
  const resp = await fetch(`${BASE}${QRPOLL_PATH}`, {
    method: 'POST',
    headers: buildHeaders(guestCookie, xs, xt),
    body: JSON.stringify({ qrId: qr.qr_id, code: qr.code })
  })

  let setCookie = []
  try {
    setCookie = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : []
  } catch { }

  const json = await resp.json().catch(() => null)
  const data = json?.data || {}
  const loginInfo = data.login_info || data.loginInfo

  // 已确认登录：响应体携带登录信息，或 Set-Cookie 返回 web_session
  if (loginInfo?.session || setCookie.some((c) => c.startsWith('web_session='))) {
    return { status: 'success', loginInfo, setCookie }
  }

  if (json?.code !== 0 && json?.success === false) {
    return { status: 'error', message: json.message || '接口返回异常' }
  }

  // 0=未扫码 1=已扫码待确认
  const codeStatus = Number(data.codeStatus)
  if (codeStatus === 1) return { status: 'scanned' }
  return { status: 'wait', codeStatus }
}

/**
 * 合并游客 Cookie、Set-Cookie 及登录信息，得到完整登录态 Cookie
 */
function mergeCookies (guestCookie, setCookie, loginInfo) {
  const map = new Map()
  for (const part of guestCookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0) map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim())
  }
  if (Array.isArray(setCookie)) {
    for (const c of setCookie) {
      const first = c.split(';')[0].trim()
      const idx = first.indexOf('=')
      if (idx > 0) map.set(first.slice(0, idx).trim(), first.slice(idx + 1))
    }
  }
  if (loginInfo?.session) map.set('web_session', String(loginInfo.session))
  if (loginInfo?.id_token) map.set('id_token', String(loginInfo.id_token))
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * 小红书扫码登录主流程
 * @param {*} e - 消息对象
 */
export async function xiaohongshuLogin (e) {
  const messageIds = []
  const recallMessages = async () => {
    await Promise.all(messageIds.filter(Boolean).map(async (id) => {
      try {
        await e.bot.recallMsg(e, id)
      } catch { }
    }))
  }

  try {
    const disclaimerMsg = await e.reply('免责声明:\n您将通过扫码完成获取小红书网页端的用户登录凭证（ck），该ck将用于请求小红书 WEB API 接口。\n本BOT不会上传任何有关你的信息到第三方，所配置的 ck 只会用于请求官方 API 接口。\n我方仅提供笔记解析及相关小红书内容服务，若您的账号封禁、被盗等处罚与我方无关。\n害怕风险请勿扫码 ~', true)
    messageIds.push(getMessageId(disclaimerMsg))

    const guestCookie = await xiaohongshuSign.createGuestCookie({ timeout: 20000 })
    const a1 = xiaohongshuSign.extractA1FromCookie(guestCookie).trim()

    const qr = await createQrcode(a1, guestCookie)
    logger.mark(`[小红书登录] 二维码生成成功: ${qr.qr_id}`)

    const qrcodeMsg = await e.reply(
      await Render('xiaohongshu/qrcodeImg', { share_url: qr.url }),
      true
    )
    messageIds.push(getMessageId(qrcodeMsg))

    let scanned = false
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      const result = await pollQrcode(qr, a1, guestCookie)

      if (result.status === 'success') {
        const cookieString = mergeCookies(guestCookie, result.setCookie, result.loginInfo)
        Config.modify('cookies', 'xiaohongshu', cookieString)
        await e.reply('登录成功！用户登录凭证已保存至 cookies.yaml', true)
        await recallMessages()
        return true
      }

      if (result.status === 'scanned' && !scanned) {
        scanned = true
        const scannedMsg = await e.reply('二维码已扫码，请在手机上确认登录', true)
        messageIds.push(getMessageId(scannedMsg))
      }

      if (result.status === 'error') {
        await e.reply(`登录接口错误：${result.message || '未知错误'}，请重试`, true)
        await recallMessages()
        return true
      }

      await sleep(2500)
    }

    await e.reply('登录超时！二维码已失效，请重新登录', true)
    await recallMessages()
  } catch (error) {
    logger.error('[小红书登录] 流程出错', error)
    await e.reply('登录过程出错，请查看控制台日志', true)
  }
  return true
}