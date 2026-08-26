import { Common, Config, Render } from '../../utils/index.js'
import * as QRCode from 'qrcode'
import fs from 'node:fs'

const CHROME_VERSION = '142'

/** 与 UA 匹配的桌面 Chrome 请求头，尽量贴近真实浏览器以减少风控 */
const biliLoginHeaders = () => ({
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  Referer: 'https://www.bilibili.com/',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': `"Not A;Brand";v="99", "Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}"`,
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site'
})

/**
 * 直接请求 B站接口，完全绕开 amagi 封装，
 * 以便完全控制 UA / cookie / 参数。
 */
const fetchBiliJson = async (url, cookie) => {
  const resp = await fetch(url, {
    headers: {
      ...biliLoginHeaders(),
      Cookie: cookie
    }
  })
  return { json: await resp.json(), headers: resp.headers }
}

/** 从响应头提取 set-cookie 名称=值列表（含多值场景） */
const parseSetCookie = (headers) => {
  if (!headers) return []
  const list = (typeof headers.getSetCookie === 'function')
    ? headers.getSetCookie()
    : (headers.get?.('set-cookie') ? [headers.get('set-cookie')] : [])
  const arr = Array.isArray(list) ? list : []
  return arr.map(c => c.split(';')[0].trim()).filter(c => c)
}

/**
 * 获取 buvid 匿名设备 cookie。
 * B站 web 扫码登录要求 qrcode/generate 带 buvid3/b_nut，
 * 否则扫码确认时提示「缺少参数」。
 * @returns {Promise<{cookie: string, buvid3: string}>}
 */
const genBuvid = async () => {
  try {
    const { json } = await fetchBiliJson('https://api.bilibili.com/x/frontend/finger/spi', '')
    const b3 = json?.data?.b_3
    const b4 = json?.data?.b_4
    if (!b3) return { cookie: '', buvid3: '' }
    const parts = [`buvid3=${encodeURIComponent(b3)}`]
    if (b4) parts.push(`buvid4=${encodeURIComponent(b4)}`)
    parts.push(`b_nut=${Date.now()}`)
    return { cookie: parts.join('; '), buvid3: b3 }
  } catch (err) {
    console.error('[B站登录] 获取 buvid 失败:', err?.message || err)
    return { cookie: '', buvid3: '' }
  }
}

/**
 * 处理哔哩哔哩登录流程
 * @param {*} e - 消息对象
 */
export const bilibiliLogin = async (e) => {
  console.log('[B站登录] 开始扫码登录流程')
  /** 申请二维码前补齐 buvid 设备 cookie */
  const { cookie: buvidCookie, buvid3 } = await genBuvid()
  const baseCookie = Config.cookies.bilibili || ''
  console.log(`[B站登录] buvid3=${buvid3 || '(空)'} buvidCookie=${buvidCookie ? '有' : '空'}`)

  /** 申请二维码 */
  const genUrl = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
  const qrCookie = [baseCookie, buvidCookie].filter(Boolean).join('; ')
  const genResp = await fetchBiliJson(genUrl, qrCookie)
  const genJson = genResp.json
  if (genJson.code !== 0) {
    throw new Error(`申请二维码失败：code=${genJson.code} ${genJson.message || ''}`)
  }
  const qrcodeKey = genJson.data?.qrcode_key
  const qrUrl = genJson.data?.url
  if (!qrcodeKey || !qrUrl) {
    console.error('[B站登录] generate 返回异常：', JSON.stringify(genJson).slice(0, 2000))
    throw new Error('申请二维码返回缺少 qrcode_key/url')
  }

  /** 轮询需沿用 generate 阶段下发的会话 cookie（bili_jct 等），保证扫码确认时上下文一致 */
  const genSetCookies = parseSetCookie(genResp.headers)
  const pollCookie = [...new Set([baseCookie, buvidCookie, ...genSetCookies].filter(Boolean))].join('; ')
  if (genSetCookies.length > 0) console.log(`[B站登录] 会话cookie: ${genSetCookies.join(', ')}`)

  const qrimg = await QRCode.toDataURL(qrUrl) // 将二维码URL转换为base64图片
  const base64Data = qrimg ? qrimg.replace(/^data:image\/\w+;base64,/, '') : ''
  const buffer = Buffer.from(base64Data, 'base64')
  fs.writeFileSync(`${Common.tempDri.default}BilibiliLoginQrcode.png`, new Uint8Array(buffer))

  /** @type {(string | number | undefined)[]} */
  const messageIds = []

  const disclaimerMsg = await e.reply('免责声明:\n您将通过扫码完成获取哔哩哔哩网页端的用户登录凭证（ck），该ck将用于请求哔哩哔哩WEB API接口。\n本BOT不会上传任何有关你的信息到第三方，所配置的 ck 只会用于请求官方 API 接口。\n我方仅提供视频解析及相关哔哩哔哩内容服务,若您的账号封禁、被盗等处罚与我方无关。\n害怕风险请勿扫码 ~')
  const qrcodeMsg = await e.reply(
    await Render('bilibili/qrcodeImg', { share_url: qrUrl }),
    true
  )

  messageIds.push(disclaimerMsg?.message_id, qrcodeMsg?.message_id)

  const recallMessages = async () => {
    await Promise.all(messageIds.filter(id => id).map(async (id) => {
      try {
        await e.bot.recallMsg(e, id)
      } catch { }
    }))
  }

  const handleLoginSuccess = async (setCookies) => {
    if (!Array.isArray(setCookies) || setCookies.length === 0) {
      console.error('[B站登录] 登录成功但未取到 set-cookie：', JSON.stringify(setCookies))
      throw new Error('登录成功但未取到用户凭证（set-cookie 为空）')
    }
    Config.modify('cookies', 'bilibili', setCookies.join('; '))
    await e.reply('登录成功！用户登录凭证已保存至cookies.yaml', true)
    await recallMessages()
  }

  const handleQrScanned = async () => {
    const scannedMsg = await e.reply('二维码已扫码，未确认', true)
    messageIds.push(scannedMsg?.message_id)
    try {
      if (qrcodeMsg?.message_id) {
        await e.bot.recallMsg(e, qrcodeMsg.message_id)
      }
    } catch { }
    const index = messageIds.indexOf(qrcodeMsg?.message_id)
    if (index > -1) messageIds.splice(index, 1)
  }

  const handleQrExpired = async () => {
    await e.reply('二维码已失效', true)
    await recallMessages()
  }

  /** 轮询二维码状态 */
  let hasScanned = false
  const pollUrl = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`

  while (true) {
    try {
      const { json, headers } = await fetchBiliJson(pollUrl, pollCookie)
      const statusCode = json?.data?.code

      switch (statusCode) {
        case 0: { // 登录成功
          const setCookies = parseSetCookie(headers)
            .filter(c => !c.startsWith('buvid'))
          await handleLoginSuccess(setCookies)
          return
        }

        case 86038: // 二维码失效
          await handleQrExpired()
          return

        case 86090: // 二维码已扫描，未确认
          if (!hasScanned) {
            await handleQrScanned()
            hasScanned = true
          }
          break

        case 86101: // 未扫描
        default:
          break
      }

      await Common.sleep(3000)
    } catch (error) {
      console.error('轮询二维码状态时发生错误:', error)
      await e.reply('登录过程中发生错误，请重试', true)
      await recallMessages()
      return
    }
  }
}