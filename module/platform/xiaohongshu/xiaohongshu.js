import { Base, downloadVideo } from '../../utils/Base.js'
import { getCachedData, setCachedData, runSingleFlightData } from '../../utils/ResourceCache.js'
import { baseHeaders } from '../../utils/Networks.js'
import { Render } from '../../utils/Render.js'
import Config from '../../utils/Config.js'
import Common from '../../utils/Common.js'
import { processImageUrl } from '../../utils/ImageHelper.js'
import { makeForwardMsgBatched } from '../../utils/ForwardMsg.js'
import { markParseFailed, markParseLimited } from '../../utils/EmojiReaction.js'
import { buildLivePhotoMessages, buildLivePhotoTipMessage, pickXiaohongshuImageUrl } from './livePhoto.js'
import { buildXiaohongshuEmojiList, buildXiaohongshuText } from './comments.js'
import { xiaohongshuSign, createBoundXiaohongshuFetcher } from '@ikenxuan/amagi'

// 无用户 Cookie 时自动生成小红书游客会话（含 web_session），等效于未登录抓取的 CK
let guestCookieCache = null
const resolveXiaohongshuCookie = async () => {
  if (Config.cookies.xiaohongshu) return Config.cookies.xiaohongshu
  if (!guestCookieCache) guestCookieCache = await xiaohongshuSign.createGuestCookie({ timeout: 15000 })
  return guestCookieCache
}

const buildShareUrl = (data) => `https://www.xiaohongshu.com/discovery/item/${data.note_id}${data.xsec_token ? `?xsec_token=${data.xsec_token}` : ''}`

const getNoteCard = (noteResponse) => noteResponse?.data?.data?.items?.[0]?.note_card

const normalizeSendContent = () => Array.isArray(Config.xiaohongshu.sendContent) ? Config.xiaohongshu.sendContent : []

const formatCount = (value) => value ?? 0

const collectVideoStreams = (streamData) => {
  // 小红书码流分组键：EF5=H.265(无水印) EF4=H.264(有印) EF7/EF6=其他；EF5 优先保画质且无印
  const codecPriority = ['EF5', 'EF4', 'EF7', 'EF6']
  const streams = []
  for (const codec of codecPriority) {
    if (Array.isArray(streamData?.[codec])) streams.push(...streamData[codec])
  }
  return streams
}

const getQualityLevel = (stream) => {
  const pixels = (stream.width || 0) * (stream.height || 0)
  if (pixels >= 3840 * 2160) return '4k'
  if (pixels >= 2560 * 1440) return '2k'
  if (pixels >= 1920 * 1080) return '1080p'
  if (pixels >= 1280 * 720) return '720p'
  return '540p'
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
// 体积优先：具体档位体积超限时已自动下调档位
let xhsVolumeAdjusted = false
// 设定档位的体积（MB），供信息图显示“实际解析体积 设定档位体积/限制体积”
let xhsSetSizeMb = 0

const selectVideoStream = (streamData) => {
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
    xhsSizeLimitMb = Config.xiaohongshu.maxAutoVideoSize || 50
    const limit = xhsSizeLimitMb * 1024 * 1024
    const sized = streams.filter(s => s.size != null)
    xhsSizeExceeded = sized.length > 0 && sized.every(s => s.size > limit)
    if (xhsSizeExceeded) {
      // 所有清晰度均超过体积上限：取最小清晰度体积用于信息图标红，并返回 null 由调用方拦截
      xhsExceedBytes = sized.reduce((a, b) => ((a.size || 0) < (b.size || 0) ? a : b)).size || 0
      return null
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

  // 体积优先：设置具体档位时，若该档位体积超过 maxAutoVideoSize 则自动下调到能发出的档位
  if (Config.xiaohongshu.volumePriority && quality !== 'hdr') {
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
  constructor (e, iddata) {
    super(e)
    this.e = e
    this.type = iddata?.type
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
    // 同一笔记多群转发时复用详情数据，避免重复请求小红书 API
    const dataKey = `xhs:${data.note_id}`
    const noteData = await runSingleFlightData(dataKey, async () => {
      const cached = getCachedData(dataKey)
      if (cached) return cached
      const fresh = await xhsFetcher.fetchNoteDetail({
        typeMode: 'strict',
        note_id: data.note_id,
        xsec_token: data.xsec_token
      })
      setCachedData(dataKey, fresh)
      return fresh
    })
    const card = getNoteCard(noteData)
    if (!card) {
      throw new Error(noteData?.success === false
        ? `小红书笔记获取失败: ${noteData.message || '未知错误'}`
        : '小红书笔记数据为空')
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

    if (sendContent.includes('info')) {
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
        const stream = selectVideoStream(card.video.media?.stream)
        currentVideoBytes = stream?.size || 0
        const codecMap = { EF5: 'H.265', EF4: 'H.264', EF6: 'H.266', EF7: 'AV1' }
        const rawCodec = stream?.video_codec || ''
        const dispSizeBytes = stream?.size || (xhsSizeExceeded ? xhsExceedBytes : 0)
        video = {
          width: stream?.width || 0,
          height: stream?.height || 0,
          encoding: rawCodec ? (codecMap[rawCodec] || rawCodec) : '',
          hdr: stream?.hdr_type || 0,
          size: dispSizeBytes ? (dispSizeBytes / 1048576).toFixed(2) : '',
          sizeExceeded: xhsSizeExceeded,
          sizeLimit: xhsSizeLimitMb,
          sizeSet: xhsSetSizeMb ? xhsSetSizeMb.toFixed(2) : '',
          volumeAdjusted: xhsVolumeAdjusted
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
      let hasGeneratedLivePhoto = false

      for (const [index, item] of (card.image_list || []).entries()) {
        if (item?.live_photo && item?.stream) {
          const livePhoto = await buildLivePhotoMessages(item, index)
          tempFiles.push(...livePhoto.tempFiles)
          hasGeneratedLivePhoto = hasGeneratedLivePhoto || livePhoto.generatedLivePhoto
          if (livePhoto.messages.length > 0) {
            imageMessages.push(...livePhoto.messages)
            continue
          }
        }

        const imageUrl = await processImageUrl(pickXiaohongshuImageUrl(item), card.title || '小红书图片', index, {
          Referer: 'https://www.xiaohongshu.com',
          Cookie: xhsCookie
        })
        if (imageUrl) imageMessages.push(segment.image(imageUrl))
      }

      if (hasGeneratedLivePhoto) imageMessages.push(await buildLivePhotoTipMessage())

      try {
        if (imageMessages.length === 1) {
          await this.e.reply(imageMessages[0])
        } else if (imageMessages.length > 1) {
          for (const forward of await makeForwardMsgBatched(this.e, imageMessages, '小红书图集解析结果')) await this.e.reply(forward)
        }
      } finally {
        for (const item of tempFiles) {
          if (item?.filepath) await Common.removeFile(item.filepath, true)
        }
      }
    }

    if (card.video && sendContent.includes('video')) {
      const stream = selectVideoStream(card.video.media?.stream)
      if (xhsSizeExceeded) {
        markParseLimited(this.e, '体积超限')
        await this.e.reply(`解析到的视频所有清晰度均超过 ${xhsSizeLimitMb}MB，已停止下载\n当前体积上限：${xhsSizeLimitMb}MB`, { reply: true })
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
        cacheKey: `xhs:${card?.id || card?.note_id || videoUrl}`
      })
    }

    return true
  }
}
