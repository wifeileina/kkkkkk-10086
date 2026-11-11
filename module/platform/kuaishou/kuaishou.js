import { Base, Config, Render, Networks, downloadVideo, markParseFailed } from '../../utils/index.js'
import { getTierSizeLimitBytes, buildTierMessage } from '../../utils/ParsePermission.js'
import  comments  from './comments.js'

/** 从作品 manifest 提取全部清晰度档位（按分辨率升序） */
const buildKuaishouTierList = (photo) => {
  const tiers = []
  const seen = new Set()
  for (const set of photo?.manifest?.adaptationSet || []) {
    for (const rep of set?.representation || []) {
      if (!rep?.url || rep.hidden) continue
      const width = Number(rep.width) || 0
      const height = Number(rep.height) || 0
      const bitrateKbps = rep.avgBitrate ? Math.round(rep.avgBitrate / 1000) : 0
      // 同分辨率同码率的重复档合并
      const dedupKey = `${width}x${height}:${bitrateKbps}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      const label = rep.qualityLabel || (height ? `${height}P` : rep.id || '默认')
      const resolution = width && height ? `  ${width}×${height}` : ''
      const bitrate = bitrateKbps ? `  ${bitrateKbps}kbps` : ''
      tiers.push({
        url: rep.url,
        label,
        width,
        height,
        bitrateKbps,
        sizeBytes: 0,
        line: `${label}${resolution}${bitrate}`
      })
    }
  }
  // 无多档信息时退回单一默认地址，至少保证可选项可用
  if (!tiers.length && photo?.photoUrl) {
    tiers.push({ url: photo.photoUrl, label: '默认', width: 0, height: 0, bitrateKbps: 0, sizeBytes: 0, line: '默认' })
  }
  return tiers.sort((a, b) => (a.height - b.height) || (a.bitrateKbps - b.bitrateKbps))
}

export default class KuaiShou extends Base {
  /**
   * @param {*} e 事件对象
   * @param {*} Iddata 作品标识
   * @param {{ tierMode?: boolean, tierUrl?: string }} [options] 档位模式：tierMode 仅列出档位，tierUrl 指定档位下载
   */
  constructor (e = {}, Iddata, options) {
    super()
    this.e = e
    this.tierMode = options?.tierMode ?? false
    this.tierUrl = options?.tierUrl || ''
  }

  async Action (data) {
    const videoDetail = data.VideoData?.data?.data?.visionVideoDetail || data.VideoData?.data?.visionVideoDetail
    const commentsData = data.CommentsData?.data || data.CommentsData || data.CommentData
    const emojiList = data.EmojiData?.data?.data?.visionBaseEmoticons?.iconUrls || data.EmojiData?.data?.visionBaseEmoticons?.iconUrls || {}

    if (videoDetail?.status !== 1) {
      markParseFailed(this.e, '快手作品状态异常/不支持解析')
      await this.e.reply('不支持解析的视频')
      return true
    }

    // 档位模式：仅列出全部清晰度档位，供 xk解析档位 命令选择
    if (this.tierMode === true) {
      const tierList = buildKuaishouTierList(videoDetail.photo)
      const { text, selectable } = buildTierMessage(this.e, tierList, getTierSizeLimitBytes('kuaishou'))
      await this.e?.reply?.(text)
      return { type: 'kuaishou_tier_selection', photoId: videoDetail.photo?.id, tiers: selectable }
    }

    ;Config.app.parseTip && await this.e.reply('检测到快手链接，开始解析')
    // 指定档位下载时使用所选码流，否则用默认地址
    const video_url = this.tierUrl || videoDetail.photo.photoUrl
    const transformedData = Object.entries(emojiList).map(([ name, path ]) => {
      return { name, url: `https:${path}` }
    })
    const CommentsData = await comments(commentsData, transformedData)
    const videoheaders = await new Networks({ url: video_url, headers: this.headers }).getHeaders()
    const Size = videoheaders['content-length'] ? parseInt(videoheaders['content-length'], 10) : 0
    const videoSizeInMB = (Size / (1024 * 1024)).toFixed(2)
    const img = await Render.render(
      'kuaishou/comment',
      {
        Type: '视频',
        viewCount: videoDetail.photo.viewCount,
        CommentsData,
        CommentLength: String(CommentsData?.length ? CommentsData.length : 0),
        share_url: video_url,
        VideoSize: videoSizeInMB,
        likeCount: videoDetail.photo.likeCount,
        }
    )
    await this.e.reply(img)
    await downloadVideo(this.e, {
      video_url,
      title: {
        timestampTitle: `tmp_${Date.now()}.mp4`,
        originTitle: `${videoDetail.photo.caption || '快手作品'}.mp4`
      },
      // 缓存 key 带上所选档位地址，避免指定档位下载时复用其它档位的缓存文件
      cacheKey: `kuaishou:${videoDetail?.photo?.photoId || video_url}:${this.tierUrl || 'auto'}`,
      nameParts: {
        author: videoDetail?.photo?.userName || videoDetail?.photo?.user?.name || '',
        description: videoDetail?.photo?.caption || '快手作品',
        tags: []
      }
    })
    return true
  }

}
