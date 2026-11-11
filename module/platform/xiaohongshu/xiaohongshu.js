import { Base, downloadVideo } from '../../utils/Base.js'
import { getCachedData, setCachedData, runSingleFlightData } from '../../utils/ResourceCache.js'
import { baseHeaders } from '../../utils/Networks.js'
import { Render } from '../../utils/Render.js'
import Config from '../../utils/Config.js'
import Common from '../../utils/Common.js'
import { processImageUrl } from '../../utils/ImageHelper.js'
import { makeForwardMsgBatched } from '../../utils/ForwardMsg.js'
import { markParseFailed, markParseLimited } from '../../utils/EmojiReaction.js'
import { canBypassSizeLimit, overLimitHintMode, overLimitPermissionLabel, overLimitTipSuffix, isCommandParse, shouldSkipInfoGraphic, markInfoGraphicSent, getTierSizeLimitBytes, buildTierMessage } from '../../utils/ParsePermission.js'
import { buildLivePhotoMessages, buildLivePhotoTipMessage, pickXiaohongshuImageUrl } from './livePhoto.js'
import { buildXiaohongshuEmojiList, buildXiaohongshuText } from './comments.js'
import { isImageFileSendMode, buildMediaName, sendMediaFiles } from '../../utils/FileSend.js'
import { xiaohongshuSign, createBoundXiaohongshuFetcher } from '@ikenxuan/amagi'

// 无用户 Cookie 时自动生成小红书游客会话（含 web_session），等效于未登录抓取的 CK
let guestCookieCache = null
const resolveXiaohongshuCookie = async () => {
  if (Config.cookies.xiaohongshu) return Config.cookies.xiaohongshu
  if (!guestCookieCache) guestCookieCache = await xiaohongshuSign.createGuestCookie({ timeout: 15000 })
  return guestCookieCache
}

const buildShareUrl = (data) => `https://www.xiaohongshu.com/discovery/item/${data.note_id}${data.xsec_token ? `?xsec_token=${data.xsec_token}` : ''}`

const normalizeForwardText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 构造转发/文件名所需的作者、描述与标签（文件名规则与转发标题一致）。 */
const buildXiaohongshuNameParts = (card = {}, emojiData = []) => {
  const noteDesc = buildXiaohongshuText(card.desc, emojiData, [], { stripTopicMarker: true })
  const tags = []
  const addTag = (value) => {
    const tag = normalizeForwardText(String(value ?? '').replace(/^#+/, '').replace(/#+$/, ''))
    if (tag && !tags.includes(tag)) tags.push(tag)
  }

  // 小红书话题用双 # 包裹（可含空格），提取为标签并从描述中移除
  const cleanDescription = noteDesc
    .replace(/#[^#\n\s]+(?:[ \u00A0]+[^#\n\s]+)*#/g, (match) => {
      addTag(match.slice(1, -1))
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()

  return {
    author: normalizeForwardText(card.user?.nickname || card.user?.nick_name).replace(/^@+/, ''),
    description: cleanDescription || normalizeForwardText(card.title),
    tags
  }
}

/** 构造图文转发标题：@作者 描述 #标签，与抖音图文的转发标题格式保持一致。 */
const buildXiaohongshuForwardTitle = (card = {}, emojiData = []) => {
  const { author, description, tags } = buildXiaohongshuNameParts(card, emojiData)
  return [`@${author || '未知用户'}`, description, tags.map((tag) => `#${tag}`).join(' ')]
    .filter(Boolean)
    .join(' ')
}

const getNoteCard = (noteResponse) => noteResponse?.data?.data?.items?.[0]?.note_card

const normalizeSendContent = () => Array.isArray(Config.xiaohongshu.sendContent) ? Config.xiaohongshu.sendContent : []

const formatCount = (value) => value ?? 0

const collectVideoStreams = (streamData) => {
  // 小红书码流分组键有两种命名：
  // 登录态返回 EF5(H.265/无水印)、EF4(H.264)、EF7、EF6；
  // 游客态返回 h265、h264、h266、av1。统一按「保画质优先」顺序拼接
  const codecPriority = ['EF5', 'h265', 'EF4', 'h264', 'EF7', 'h266', 'EF6', 'av1']
  const streams = []
  for (const codec of codecPriority) {
    if (Array.isArray(streamData?.[codec])) streams.push(...streamData[codec])
  }
  return streams
}

/** 是否为「服务端降级」的笔记数据：视频笔记却只返回单一码流（通常只剩 720P） */
const isDegradedNoteData = (noteData) => {
  const card = getNoteCard(noteData)
  if (!card?.video) return false
  return collectVideoStreams(card?.video?.media?.stream).length <= 1
}

/**
 * 请求笔记详情；小红书 feed 接口偶发只返回 720P 单一码流（实测约 1/5 概率），
 * 遇到该降级响应时重试，默认重试 1 次；档位模式需要完整档位，可多试一次。
 */
const fetchNoteDetailWithStreams = async (fetcher, params, extraRetries = 1) => {
  let noteData = await fetcher.fetchNoteDetail(params)
  for (let i = 0; i < extraRetries && isDegradedNoteData(noteData); i++) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    noteData = await fetcher.fetchNoteDetail(params)
  }
  return noteData
}

const getQualityLevel = (stream) => {
  const pixels = (stream.width || 0) * (stream.height || 0)
  if (pixels >= 3840 * 2160) return '4k'
  if (pixels >= 2560 * 1440) return '2k'
  if (pixels >= 1920 * 1080) return '1080p'
  if (pixels >= 1280 * 720) return '720p'
  return '540p'
}

const QUALITY_LABELS = { '4k': '4K', '2k': '2K', '1080p': '1080P', '720p': '720P', '540p': '540P' }

/**
 * 小红书 HDR 类型标签（实测同笔记三条 4K 码流逐一下载比对得出）：
 * hdr_type=1 为杜比视界（DoVi Profile 8.4，HLG 基底），hdr_type=2 为普通 HDR(HLG)，0 为 SDR
 */
const hdrTypeLabel = (hdrType) => {
  const type = Number(hdrType) || 0
  if (type === 1) return '杜比视界'
  if (type === 2) return 'HDR'
  return ''
}

/** 从笔记的码流数据提取全部清晰度档位（按体积升序，index 对应原始码流下标） */
const buildXiaohongshuTierList = (card) => {
  const streams = collectVideoStreams(card?.video?.media?.stream)
  const seen = new Set()
  const tiers = []
  for (const stream of streams) {
    const url = getStreamUrl(stream)
    if (!url) continue
    const width = stream.width || 0
    const height = stream.height || 0
    const size = Number(stream.size) || 0
    // 同分辨率同体积的重复码流（多编码）合并，避免列表重复
    const dedupKey = `${width}x${height}:${Math.round(size / 1024)}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    const quality = getQualityLevel(stream)
    const hdrLabel = hdrTypeLabel(stream.hdr_type)
    const label = `${QUALITY_LABELS[quality] || quality.toUpperCase()}${hdrLabel ? ` ${hdrLabel}` : ''}`
    const sizeMb = size ? (size / (1024 * 1024)).toFixed(1) : ''
    const resolution = width && height ? `  ${width}×${height}` : ''
    tiers.push({
      label,
      url,
      width,
      height,
      size: size,
      sizeBytes: size,
      sizeMb,
      line: `${label}${resolution}${sizeMb ? `  ${sizeMb}MB` : ''}`
    })
  }
  // 无多档信息时退回默认地址，至少保证有可选项
  const fallbackUrl = card?.video ? getVideoUrl(card, null) : ''
  if (!tiers.length && fallbackUrl) {
    tiers.push({ label: '默认', url: fallbackUrl, width: 0, height: 0, size: 0, sizeBytes: 0, sizeMb: '', line: '默认' })
  }
  return tiers.sort((a, b) => a.size - b.size)
}

/** 指定档位下载时按地址定位码流；否则按配置挑选 */
const pickXiaohongshuStream = (card, tierUrl, e) => {
  if (tierUrl) {
    const matched = collectVideoStreams(card?.video?.media?.stream).find((stream) => getStreamUrl(stream) === tierUrl)
    if (matched) {
      // 用户显式指定档位：不再按体积上限拦截
      xhsSizeExceeded = false
      xhsExceedBytes = 0
      return matched
    }
  }
  return selectVideoStream(card?.video?.media?.stream, canBypassSizeLimit(e))
}

// 小红书 feed 返回的流项为 master_url + backup_urls（EF 分组），此处兜底兼容多种命名
const getStreamUrl = (stream) =>
  stream?.master_url || stream?.masterUrl || stream?.backup_urls?.[0] || stream?.backupUrls?.[0] || stream?.backUpUrls?.[0] || ''

const getVideoUrl = (card, stream) =>
  getStreamUrl(stream) ||
  card?.video?.media?.video?.url ||
  card?.video?.urlDefault ||
  card?.video?.url_default ||
  card?.video?.rawUrl ||
  ''

// 小红书体积上限（适配模式）状态：记录是否所有清晰度均超限、限制值与用于展示的超限体积
let xhsSizeExceeded = false
let xhsSizeLimitMb = 0
let xhsExceedBytes = 0
// 体积上限下探：具体档位体积超限时已自动下调档位
let xhsVolumeAdjusted = false
// 设定档位的体积（MB），供信息图显示“实际解析体积 设定档位体积/限制体积”
let xhsSetSizeMb = 0

const selectVideoStream = (streamData, bypass = false) => {
  // 无 size 字段时按编解码优先级顺序保留原始顺序，避免已按码流大小降序排序
  let streams = collectVideoStreams(streamData)
  if (!streams.length) return null

  // 存在 size 字段才按分辨率大小降序，否则维持原顺序（h265 无水印优先）
  if (streams.some(s => s.size != null)) {
    streams = streams.sort((a, b) => (b.size || 0) - (a.size || 0))
  }

  const quality = Config.xiaohongshu.videoQuality || '4k'
  const qualityPriority = ['4k', '2k', '1080p', '720p', '540p']

  if (quality === 'hdr') {
    // 优先选择 hdr_type 非 0 的 HDR 码流（已按大小降序），无 HDR 码流时回退普通码流
    const hdrStreams = streams.filter(stream => stream.hdr_type)
    const pool = hdrStreams.length ? hdrStreams : streams
    return pool[0]
  }

  if (quality === 'adapt') {
    // 关闭「视频体积上限」时不设限制，直接取最高清晰度码流
    if (Config.xiaohongshu.limitVideoSize === false) {
      xhsSizeExceeded = false
      xhsExceedBytes = 0
      return streams[0]
    }
    xhsSizeLimitMb = Config.xiaohongshu.maxAutoVideoSize || 50
    const limit = xhsSizeLimitMb * 1024 * 1024
    const sized = streams.filter(s => s.size != null)
    xhsSizeExceeded = sized.length > 0 && sized.every(s => s.size > limit)
    if (xhsSizeExceeded) {
      // 所有清晰度均超过体积上限：取最小清晰度体积用于信息图标红；未获超限指令权限时返回 null 由调用方拦截
      xhsExceedBytes = sized.reduce((a, b) => ((a.size || 0) < (b.size || 0) ? a : b)).size || 0
      // 已获超限指令权限：返回最大清晰度档供强制下载，信息图仍保留超限提示
      return bypass ? streams[0] : null
    }
    xhsExceedBytes = 0
    return streams.find(stream => (stream.size || 0) <= limit) || streams.at(-1)
  }

  const targetIndex = qualityPriority.indexOf(quality)
  const fallbackOrder = targetIndex >= 0
    ? [...qualityPriority.slice(targetIndex), ...qualityPriority.slice(0, targetIndex).reverse()]
    : qualityPriority

  for (const item of fallbackOrder) {
    const stream = streams.find(stream => getQualityLevel(stream) === item)
    if (stream) return stream
  }

  // 体积上限下探：设置具体档位时，若该档位体积超过 maxAutoVideoSize 则自动下调到能发出的档位
  if (Config.xiaohongshu.limitVideoSize !== false && quality !== 'hdr') {
    xhsSizeLimitMb = Config.xiaohongshu.maxAutoVideoSize || 50
    const vpLimit = xhsSizeLimitMb * 1024 * 1024
    const sized = streams.filter(s => s.size != null)
    if (sized.length) {
      const chosen = streams.find(stream => getQualityLevel(stream) === quality) || streams[0]
      const chosenBytes = chosen?.size || 0
      if (chosenBytes > vpLimit) {
        const fit = sized.filter(s => (s.size || 0) <= vpLimit)
        const pick = fit.length
          ? fit.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a))
          : sized.reduce((a, b) => ((b.size || 0) < (a.size || 0) ? b : a))
        xhsVolumeAdjusted = true
        xhsSetSizeMb = chosenBytes / (1024 * 1024)
        xhsSizeExceeded = false
        xhsExceedBytes = 0
        return pick
      }
    }
  }

  return streams[0]
}

const formatTime = (timestamp) => {
  const time = Number(timestamp)
  if (!time) return '未知时间'
  const date = new Date(time < 10000000000 ? time * 1000 : time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const pickCommentPictureUrl = (picture) => {
  if (typeof picture === 'string') return picture
  return picture?.url_default || picture?.url_pre || picture?.url || picture?.info_list?.[0]?.url || ''
}

const normalizeTagNames = (tags) => {
  if (!Array.isArray(tags)) return []
  return tags
    .map(tag => typeof tag === 'string' ? tag : tag?.name || tag?.tag || '')
    .filter(Boolean)
}

const normalizeUser = (user = {}) => ({
  nickname: user.nickname || user.nick_name || '未知用户',
  image: user.image || user.avatar || user.avatar_url || user.avatar_url_default || ''
})

const buildRenderComments = (comments, emojiData) => {
  const limit = Math.max(1, Number(Config.xiaohongshu.numcomment || 5))
  return (Array.isArray(comments) ? comments : [])
    .map(comment => ({ ...comment, show_tags: normalizeTagNames(comment.show_tags) }))
    .sort((a, b) => Number(b.show_tags.includes('user_top')) - Number(a.show_tags.includes('user_top')))
    .slice(0, limit)
    .map(comment => ({
      id: comment.id || comment.comment_id || `${comment.user_info?.user_id || 'user'}-${comment.create_time || Date.now()}`,
      user_info: normalizeUser(comment.user_info),
      content: buildXiaohongshuText(comment.content, emojiData, comment.at_users),
      create_time: formatTime(comment.create_time),
      ip_location: comment.ip_location || '',
      like_count: formatCount(comment.like_count),
      liked: Boolean(comment.liked),
      show_tags: comment.show_tags,
      sub_comment_count: String(comment.sub_comment_count || 0),
      pictures: (Array.isArray(comment.pictures) ? comment.pictures : [])
        .map(picture => ({ url_default: pickCommentPictureUrl(picture) }))
        .filter(picture => picture.url_default),
      sub_comments: (Array.isArray(comment.sub_comments) ? comment.sub_comments : []).slice(0, 3).map(item => ({
        id: item.id || item.comment_id || `${item.user_info?.user_id || 'user'}-${item.create_time || Date.now()}`,
        user_info: normalizeUser(item.user_info),
        content: buildXiaohongshuText(item.content, emojiData, item.at_users),
        create_time: formatTime(item.create_time),
        ip_location: item.ip_location || '',
        like_count: formatCount(item.like_count),
        liked: Boolean(item.liked),
        show_tags: normalizeTagNames(item.show_tags)
      }))
    }))
}

export class Xiaohongshu extends Base {
  /**
   * @param {*} e 事件对象
   * @param {*} iddata 笔记标识
   * @param {{ tierMode?: boolean, tierUrl?: string }} [options] 档位模式：tierMode 仅列出档位，tierUrl 指定档位下载
   */
  constructor (e, iddata, options) {
    super(e)
    this.e = e
    this.type = iddata?.type
    this.tierMode = options?.tierMode ?? false
    this.tierUrl = options?.tierUrl || ''
  }

  async XiaohongshuHandler (data) {
    let xhsCookie
    try {
      xhsCookie = await resolveXiaohongshuCookie()
    } catch (error) {
      logger.error(`[小红书] 获取解析会话失败: ${error?.message || error}`)
      markParseFailed(this.e, '解析会话获取失败')
      await this.e.reply('小红书解析会话获取失败，请稍后重试')
      return true
    }
    if (!xhsCookie) {
      markParseFailed(this.e, '未配置小红书 Cookies')
      await this.e.reply('我还没有小红书 Cookies，暂时无法解析')
      return true
    }

    const sendContent = normalizeSendContent()
    // 显式绑定 Cookie 创建小红书 Fetcher，避免使用初始化时可能为空的 Cookie
    const xhsFetcher = createBoundXiaohongshuFetcher(xhsCookie, {
      timeout: Config.request?.timeout || 15000,
      headers: { 'User-Agent': Config.request?.['User-Agent'] || baseHeaders?.['User-Agent'] }
    })
    // 同一笔记多群转发时复用详情数据，避免重复请求小红书 API；
    // 缓存到的是降级数据（只有单一档位）时重新请求，避免一直复用 720P
    const dataKey = `xhs:${data.note_id}`
    const noteData = await runSingleFlightData(dataKey, async () => {
      const cached = getCachedData(dataKey)
      if (cached && !isDegradedNoteData(cached)) return cached
      const fresh = await fetchNoteDetailWithStreams(xhsFetcher, {
        typeMode: 'strict',
        note_id: data.note_id,
        xsec_token: data.xsec_token
      }, this.tierMode === true ? 2 : 1)
      setCachedData(dataKey, fresh)
      return fresh
    })
    const card = getNoteCard(noteData)
    if (!card) {
      throw new Error(noteData?.success === false
        ? `小红书笔记获取失败: ${noteData.message || '未知错误'}`
        : '小红书笔记数据为空')
    }

    // 档位模式：仅列出全部清晰度档位，供 xk解析档位 命令选择
    if (this.tierMode === true) {
      if (!card.video) {
        await this.e?.reply?.('该笔记不是视频，没有可选的清晰度档位')
        return { type: 'xiaohongshu_tier_selection', note_id: card.note_id || data.note_id, tiers: [] }
      }
      const tierList = buildXiaohongshuTierList(card)
      if (!tierList.length) {
        markParseFailed(this.e, '未获取到清晰度档位')
        await this.e?.reply?.('未获取到可用的清晰度档位信息')
        return { type: 'xiaohongshu_tier_selection', note_id: card.note_id || data.note_id, tiers: [] }
      }
      const { text, selectable } = buildTierMessage(this.e, tierList, getTierSizeLimitBytes('xiaohongshu'))
      await this.e?.reply?.(text)
      return { type: 'xiaohongshu_tier_selection', note_id: card.note_id || data.note_id, tiers: selectable }
    }

    let emojiData = []
    if (sendContent.includes('info') || sendContent.includes('comment')) {
      try {
        const emojiList = await xhsFetcher.fetchEmojiList({ typeMode: 'strict' })
        emojiData = buildXiaohongshuEmojiList(emojiList)
      } catch (error) {
        logger.debug(`[小红书] 获取表情列表失败，使用纯文本渲染: ${error?.message || error}`)
      }
    }

    const xhsInfoEnabled = sendContent.includes('info')
    // 指令继续解析（如体积超限后回复「xk解析」）时，120s 内同一笔记不再重复发送信息图
    const xhsInfoSkip = xhsInfoEnabled && shouldSkipInfoGraphic(this.e, card.note_id || data.note_id)
    if (xhsInfoSkip) {
      logger.info('信息图', `指令解析：120s 内已发送过信息图，跳过重复发送 (${card.note_id || data.note_id})`)
    }
    if (xhsInfoEnabled && !xhsInfoSkip) {
      const noteDesc = buildXiaohongshuText(card.desc, emojiData, [], { stripTopicMarker: true })
      // 提取 #话题 标签（小红书用双 # 包裹，可含空格），正文去除标签并清理多余空格
      const hashtags = [...new Set((noteDesc.match(/#[^#\n\s]+(?:[ \u00A0]+[^#\n\s]+)*#/g) || [])
        .map((h) => h.slice(1, -1).trim())
        .filter(Boolean))]
      const cleanDesc = noteDesc
        .replace(/#[^#\n\s]+(?:[ \u00A0]+[^#\n\s]+)*#/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim()
      const image_url = pickXiaohongshuImageUrl(card.image_list?.[0]) || card.video?.image?.url_default || card.video?.cover?.url_default || ''
      // 视频笔记附带分辨率/编码/HDR：全部取自上屏码流
      let video = null
      let currentVideoBytes = 0
      xhsVolumeAdjusted = false
      xhsSetSizeMb = 0
      if (card?.video) {
        const stream = pickXiaohongshuStream(card, this.tierUrl, this.e)
        currentVideoBytes = stream?.size || 0
        const codecMap = { EF5: 'H.265', EF4: 'H.264', EF6: 'H.266', EF7: 'AV1' }
        const rawCodec = stream?.video_codec || ''
        const dispSizeBytes = stream?.size || (xhsSizeExceeded ? xhsExceedBytes : 0)
        video = {
          width: stream?.width || 0,
          height: stream?.height || 0,
          encoding: rawCodec ? (codecMap[rawCodec] || rawCodec) : '',
          hdr: hdrTypeLabel(stream?.hdr_type),
          size: dispSizeBytes ? (dispSizeBytes / 1048576).toFixed(2) : '',
          sizeExceeded: xhsSizeExceeded,
          sizeLimit: xhsSizeLimitMb,
          sizeSet: xhsSetSizeMb ? xhsSetSizeMb.toFixed(2) : '',
          volumeAdjusted: xhsVolumeAdjusted,
          overLimitAllowed: canBypassSizeLimit(this.e),
          overLimitHint: overLimitHintMode(),
          overLimitPermLabel: overLimitPermissionLabel(),
          commandParse: isCommandParse(this.e)
        }
      }
      const noteInfoImg = await Render('xiaohongshu/noteInfo', {
        title: card.title || '无标题',
        desc: cleanDesc,
        hashtags,
        statistics: card.interact_info || {},
        note_id: card.note_id || data.note_id,
        author: {
          avatar: card.user?.avatar || card.user?.image || '',
          nickname: card.user?.nickname || card.user?.nick_name || '未知用户',
          user_id: card.user?.user_id || card.user?.id || ''
        },
        image_url,
        time: formatTime(card.time),
        ip_location: card.ip_location || '',
        share_url: buildShareUrl(data),
        video,
        })
      await this.e.reply(noteInfoImg)
      markInfoGraphicSent(this.e, card.note_id || data.note_id)
    }

    if (sendContent.includes('comment')) {
      const commentData = await xhsFetcher.fetchNoteComments({
        typeMode: 'strict',
        note_id: data.note_id,
        xsec_token: data.xsec_token || ''
      })
      const comments = commentData?.data?.data?.comments || []
      if (!comments.length) {
        await this.e.reply('这个笔记没有评论 ~')
      } else {
        const commentListImg = await Render('xiaohongshu/comment', {
          Type: card.video ? '视频' : '图文',
          CommentsData: buildRenderComments(comments, emojiData),
          CommentLength: comments.length,
          ImageLength: card.image_list?.length || 0,
          share_url: buildShareUrl(data)
        })
        await this.e.reply(commentListImg)
      }
    }

    if (!card.video && sendContent.includes('image')) {
      const imageMessages = []
      const tempFiles = []
      const fileItems = []
      const nameParts = buildXiaohongshuNameParts(card, emojiData)
      const total = (card.image_list || []).length
      let hasGeneratedLivePhoto = false

      for (const [index, item] of (card.image_list || []).entries()) {
        if (item?.live_photo && item?.stream) {
          const livePhoto = await buildLivePhotoMessages(item, index)
          tempFiles.push(...livePhoto.tempFiles)
          hasGeneratedLivePhoto = hasGeneratedLivePhoto || livePhoto.generatedLivePhoto
          if (livePhoto.messages.length > 0) {
            imageMessages.push(...livePhoto.messages)
            if (isImageFileSendMode()) {
              // 实况图与其视频同属一组，共用同一序号后缀
              const baseName = buildMediaName({ ...nameParts, index, total, style: 'media' })
              const videoSource = livePhoto.messages.find((msg) => msg?.type === 'video')?.file
              const imageSource = livePhoto.messages.find((msg) => msg?.type === 'image')?.file
              if (videoSource) fileItems.push({ source: videoSource, baseName, ext: '.mp4' })
              if (imageSource) fileItems.push({ source: imageSource, baseName, ext: '.jpg' })
            }
            continue
          }
        }

        const imageUrl = await processImageUrl(pickXiaohongshuImageUrl(item), card.title || '小红书图片', index, {
          Referer: 'https://www.xiaohongshu.com',
          Cookie: xhsCookie
        })
        if (imageUrl) {
          imageMessages.push(segment.image(imageUrl))
          if (isImageFileSendMode()) {
            fileItems.push({
              source: imageUrl,
              baseName: buildMediaName({ ...nameParts, index, total, style: 'media' }),
              ext: '.jpg',
              headers: { Referer: 'https://www.xiaohongshu.com', Cookie: xhsCookie }
            })
          }
        }
      }

      const forwardTitle = buildXiaohongshuForwardTitle(card, emojiData)
      try {
        if (isImageFileSendMode()) {
          await sendMediaFiles(this.e, fileItems)
          if (hasGeneratedLivePhoto) await this.e.reply(await buildLivePhotoTipMessage())
        } else if (imageMessages.length === 1) {
          await this.e.reply(imageMessages[0])
        } else if (imageMessages.length > 1) {
          for (const forward of await makeForwardMsgBatched(this.e, imageMessages, forwardTitle, undefined, undefined, { titleOnce: true })) await this.e.reply(forward)
        }
      } finally {
        for (const item of tempFiles) {
          if (item?.filepath) await Common.removeFile(item.filepath, true)
        }
      }
    }

    if (card.video && sendContent.includes('video')) {
      const stream = pickXiaohongshuStream(card, this.tierUrl, this.e)
      if (xhsSizeExceeded && !canBypassSizeLimit(this.e)) {
        markParseLimited(this.e, '体积超限')
        await this.e.reply(`解析到的视频所有清晰度均超过 ${xhsSizeLimitMb}MB，已停止下载\n当前体积上限：${xhsSizeLimitMb}MB` + overLimitTipSuffix(), { reply: true })
        return true
      }
      const videoUrl = getVideoUrl(card, stream)
      if (!videoUrl) {
        markParseFailed(this.e, '未找到可用的视频地址')
        await this.e.reply('未找到可用的视频地址')
        return true
      }

      await downloadVideo(this.e, {
        video_url: videoUrl,
        title: {
          timestampTitle: `tmp_${Date.now()}.mp4`,
          originTitle: `${card.title || '小红书视频'}.mp4`
        },
        headers: {
          ...baseHeaders,
          Referer: 'https://www.xiaohongshu.com',
          Cookie: xhsCookie
        },
        // 缓存 key 带上档位（分辨率+体积），否则选 4K 时会复用到上次缓存的 1080P 文件
        cacheKey: `xhs:${card?.id || card?.note_id || ''}:${stream ? `${stream.width || 0}x${stream.height || 0}-${stream.size || 0}` : videoUrl}`,
        nameParts: buildXiaohongshuNameParts(card, emojiData)
      })
    }

    return true
  }
}
