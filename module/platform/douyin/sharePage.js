import { Networks } from '../../utils/Networks.js'

import { Config } from '../../utils/index.js'

/** 画质档位 → aweme play 接口的 ratio 参数（分享页降级链路无真实多档码流，用 ratio 让服务端返回对应清晰度） */
const getDouyinQualityRatio = (quality) => {
  const map = { '540p': '540p', '720p': '720p', '1080p': '1080p', '2k': '1440p', '4k': '2160p' }
  return map[quality] || '1080p'
}

/** 画质档位 → 目标视频高度（用于信息图展示换算） */
const getDouyinQualityHeight = (quality) => {
  const map = { '540p': 540, '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160 }
  return map[quality]
}

/**
 * 抖音分享页 HTML 解析（Web API 403 时的降级链路）
 * 与 astrbot_plugin_parser_lite 同构：请求 www.iesdouyin.com/share/video/{id}/
 * 页面，正则提取 window._ROUTER_DATA 内嵌的 SSR 数据，不依赖官方 Web API，
 * 天然绕开 a_bogus 签名风控。
 */

const SHARE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

const TTWID_REGISTER_URL = 'https://ttwid.bytedance.com/ttwid/union/register/'

/** 进程内记忆已注册的 ttwid，避免每次解析都重新注册 */
let ttwidCached = ''

const getShareHeaders = (cookie = '') => ({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'User-Agent': SHARE_UA,
  Referer: 'https://www.iesdouyin.com/',
  ...(cookie ? { Cookie: cookie } : {})
})

const getTtwidRegisterHeaders = () => ({
  'Content-Type': 'application/json',
  'User-Agent': SHARE_UA,
  Referer: 'https://www.iesdouyin.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Origin: 'https://www.iesdouyin.com'
})

/**
 * 从 Set-Cookie 响应头中提取指定 cookie 值
 * @param {string[]} setCookieHeaders
 * @param {string} name
 * @returns {string}
 */
const extractCookie = (setCookieHeaders, name) => {
  for (const header of setCookieHeaders || []) {
    const match = String(header).match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`))
    if (match) return match[1]
  }
  return ''
}

/**
 * 注册匿名 ttwid token（抖音风控的匿名设备标识）
 * 带进程内缓存，成功注册一次后后续直接复用
 * @param {string} [existingCookie] 已有 cookie，优先沿用其中的 ttwid
 * @returns {Promise<string>} 完整的 Cookie 头（含 ttwid）
 */
export const ensureTtwid = async (existingCookie = '') => {
  const baseCookie = existingCookie || ''
  const existingTtwid = extractCookie([baseCookie], 'ttwid') || ttwidCached
  if (existingTtwid) {
    ttwidCached = existingTtwid
    return baseCookie
  }

  try {
    const networks = new Networks({
      url: TTWID_REGISTER_URL,
      headers: getTtwidRegisterHeaders(),
      method: 'POST',
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.iesdouyin.com',
        union: true,
        fid: ''
      }),
      timeout: 10000,
      maxRetries: 1
    })
    const resp = await networks.request()
    const setCookieHeaders = resp?.headers?.['set-cookie'] || []
    const ttwid = extractCookie(setCookieHeaders, 'ttwid')
    if (ttwid) {
      ttwidCached = ttwid
      const updated = baseCookie ? `${baseCookie}; ttwid=${ttwid}` : `ttwid=${ttwid}`
      logger.debug(`[抖音分享页] ttwid 注册成功`)
      return updated
    }
    logger.debug('[抖音分享页] ttwid 注册未返回 cookie，将匿名请求')
    return baseCookie
  } catch (error) {
    logger.debug(`[抖音分享页] ttwid 注册失败（忽略，继续匿名请求）: ${error?.message || error}`)
    return baseCookie
  }
}

/**
 * 从分享页 HTML 中提取 _ROUTER_DATA 内嵌 JSON
 * @param {string} html
 * @returns {Object|null}
 */
const extractRouterData = (html) => {
  if (!html) return null
  const match = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s)
  if (!match || !match[1]) return null
  try {
    return JSON.parse(match[1].trim())
  } catch (error) {
    logger.debug(`[抖音分享页] _ROUTER_DATA JSON 解析失败: ${error?.message || error}`)
    return null
  }
}

/**
 * 提取作品数据（兼容视频页 video_(id)/page 与笔记页 note_(id)/page）
 * @param {Object} routerData
 * @returns {Object|null} 原始 VideoData
 */
const pickVideoData = (routerData) => {
  if (!routerData) return null
  const loader = routerData.loaderData || {}
  for (const key of ['video_(id)/page', 'note_(id)/page']) {
    const page = loader[key]
    const itemList = page?.videoInfoRes?.item_list
    if (Array.isArray(itemList) && itemList.length) return itemList[0]
  }
  return null
}

const getFirstUrl = (data) => Array.isArray(data?.url_list) ? data.url_list.find(Boolean) || '' : ''

/**
 * 将分享页的精简 VideoData 适配转换为 amagi 兼容的 aweme_detail 结构
 * 缺失字段（music/bit_rate/article_info 等）用安全默认值，保证上游渲染逻辑不崩
 * @param {Object} raw 分享页 VideoData
 * @returns {Object} aweme_detail 兼容结构
 */
const normalizeAwemeDetail = (raw) => {
  const video = raw?.video || {}
  const playUrl = video?.play_addr?.url_list?.find(Boolean) || ''
  const playUri = video?.play_addr?.uri || ''
  const durationMs = video?.duration || 0
  const statistics = raw?.statistics || {}

  // 无签名 play 端点：视频直链，配合 Range 探测/直下；ratio 跟随画质配置
  const ratio = getDouyinQualityRatio(Config.douyin?.videoQuality)
  const playEndpoint = playUri
    ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${playUri}&ratio=${ratio}&line=0`
    : playUrl
  // 兼容上游 url_list[2] 取值习惯，重复填充同一有效地址
  const playUrlList = [playEndpoint, playEndpoint, playEndpoint]

  // 按画质配置等比换算展示宽高，仅当原画高于目标档时才下调，源无尺寸则缺省
  const srcW = video?.width || 0
  const srcH = video?.height || 0
  const targetH = getDouyinQualityHeight(Config.douyin?.videoQuality)
  const renderWh = srcH > 0 && targetH && targetH < srcH
    ? { w: Math.round((srcW || srcH) * targetH / srcH), h: targetH }
    : { w: srcW, h: srcH }

  const author = raw?.author || {}

  const aweme = {
    aweme_id: raw?.aweme_id || '',
    desc: raw?.desc || '',
    create_time: raw?.create_time || Math.floor(Date.now() / 1000),
    share_url: raw?.share_url || `https://www.douyin.com/video/${raw?.aweme_id || ''}`,
    preview_title: raw?.desc || '抖音视频',
    is_slides: false,
    aweme_type: video ? 0 : 68,
    images: raw?.images?.length ? raw.images : null,
    author: {
      nickname: author?.nickname || '未知用户',
      unique_id: author?.unique_id || '',
      short_id: author?.short_id || '',
      sec_uid: author?.sec_uid || '',
      avatar_thumb: { url_list: [getFirstUrl(author?.avatar_thumb), getFirstUrl(author?.avatar_medium)].filter(Boolean) },
      avatar_larger: { url_list: [getFirstUrl(author?.avatar_medium), getFirstUrl(author?.avatar_thumb)].filter(Boolean) }
    },
    statistics: {
      digg_count: statistics?.digg_count ?? 0,
      comment_count: statistics?.comment_count ?? 0,
      collect_count: statistics?.collect_count ?? 0,
      share_count: statistics?.share_count ?? 0,
      play_count: statistics?.play_count ?? 0
    },
    music: null,
    article_info: null,
    video: video
      ? {
        ...video,
        duration: durationMs,
        play_addr: video?.play_addr || { uri: playUri, url_list: playUrlList },
        play_addr_h264: { url_list: playUrlList },
        // 构造与 Web API 结构一致的 bit_rate，便于 autoResolution 逻辑与大小展示
        bit_rate: [{
          FPS: 30,
          play_addr: {
            uri: playUri,
            url_list: playUrlList,
            data_size: 0,
            // 补展示宽高，使信息图与实际选中的清晰度一致；无目标档/源无尺寸时以 renderWh 兜底
            width: renderWh.w,
            height: renderWh.h
          }
        }],
        animated_cover: video?.cover || { url_list: [] },
        dynamic_cover: video?.cover || { url_list: [] },
        cover_original_scale: video?.cover || { url_list: [] },
        cover: video?.cover || { url_list: [] },
        origin_cover: video?.cover || { url_list: [] }
      }
      : null
  }
  return aweme
}

/**
 * 通过分享页解析抖音作品（Web API 降级链路）
 * @param {string} awemeId 作品 ID
 * @param {string} [cookie] 现有 Cookie
 * @returns {Promise<{ data: { aweme_detail: Object } }>} amagi 兼容结构
 */
export const parseDouyinViaSharePage = async (awemeId, cookie = '') => {
  const cookieWithTtwid = await ensureTtwid(cookie)
  const url = `https://www.iesdouyin.com/share/video/${awemeId}/`

  const networks = new Networks({
    url,
    headers: getShareHeaders(cookieWithTtwid),
    timeout: 15000,
    maxRetries: 2,
    type: 'text'
  })

  const html = await networks.getData()
  const routerData = extractRouterData(html)
  const raw = pickVideoData(routerData)
  if (!raw) {
    throw new Error(`分享页解析失败，未在页面中找到作品数据: ${awemeId}`)
  }

  const awemeDetail = normalizeAwemeDetail(raw)
  logger.mark(`[抖音分享页] 降级解析成功: ${awemeId} (${awemeDetail.author?.nickname || '未知作者'})`)
  // _source 标记用于上游判断数据来源（多群并发单飞时也能正确识别）
  return { data: { aweme_detail: awemeDetail }, _source: 'sharePage' }
}
