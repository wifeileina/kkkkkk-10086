import { Base, Config, UploadRecord, Networks, Render, Common, downloadFile, downloadVideo, uploadFile, baseHeaders, processImageUrl, makeForwardMsg, makeForwardMsgBatched, getQuotaInfo, getRemoteFileSize } from '../../utils/index.js'
import { getCachedData, setCachedData, runSingleFlightData } from '../../utils/ResourceCache.js'
import { parseDouyinViaSharePage } from './sharePage.js'
import { fetchDouyinDetailViaBrowser } from './webapi.js'
import { markdown } from '@karinjs/md-html'
import { burnDanmaku } from '../common/danmaku.js'
import { buildLivePhotoMessages, buildLivePhotoTipMessage } from '../common/livePhoto.js'
import { douyinComments } from './index.js'
import { getDouyinWorkCoverUrl, isDouyinArticle, isDouyinVideo, parseJsonSafely } from './workType.js'
import fs from 'fs'

/**
 * @typedef {Object} PlayAddress
 * @property {number} data_size - 视频数据大小(字节)
 * @property {string} file_cs - 文件校验信息
 * @property {string} file_hash - 文件哈希值
 * @property {number} height - 视频高度
 * @property {string} uri - 视频URI
 * @property {string} url_key - URL密钥
 * @property {string[]} url_list - URL列表
 * @property {number} width - 视频宽度
 */

/**
 * @typedef {Object} dyVideo
 * @property {number} FPS - 帧率
 * @property {string} HDR_bit - HDR比特信息
 * @property {string} HDR_type - HDR类型
 * @property {number} bit_rate - 比特率
 * @property {string} format - 视频格式
 * @property {string} gear_name - 清晰度名称
 * @property {number} is_bytevc1 - 是否使用bytevc1编码
 * @property {number} is_h265 - 是否使用h265编码
 * @property {PlayAddress} play_addr - 播放地址信息
 * @property {number} quality_type - 清晰度类型
 * @property {string} video_extra - 额外视频信息
 */

let mp4size = ''
let mp4sizeExceeded = false
let mp4sizeLimit = 0
let mp4sizeSet = ''
let volumeAdjusted = false
// 实际解析到的视频大小（字节）：优先取 bit_rate data_size，缺失时（分享页降级）由远程探测补充
let parsedDataSize = 0
let img

const getFirstUrl = (data) => data?.url_list?.find(Boolean) || ''
const formatVideoDuration = (duration) => {
  const seconds = Math.floor((duration || 0) / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
const formatVideoStats = (statistics = {}) => [
  `\n点赞：${Common.count(statistics.digg_count)}`,
  `评论：${Common.count(statistics.comment_count)}`,
  `收藏：${Common.count(statistics.collect_count)}`,
  `分享：${Common.count(statistics.share_count)}`,
  statistics.recommend_count !== undefined ? `推荐：${Common.count(statistics.recommend_count)}` : ''
].filter(Boolean).join('\n')

const hasUserConfigKey = (key) => Object.prototype.hasOwnProperty.call(Config.getConfig?.('douyin') || {}, key)
const hasDouyinContent = (legacyKey, modernKey) => {
  const sendContent = Config.douyin.sendContent
  if (modernKey && hasUserConfigKey('sendContent') && Array.isArray(sendContent) && sendContent.length > 0) {
    return sendContent.includes(modernKey)
  }
  return (Config.douyin.douyinTip || []).includes(legacyKey)
}

const getDouyinMusicUrl = (music) => {
  if (!music) return ''
  if (music.play_url?.uri) return music.play_url.uri
  try {
    return JSON.parse(music.extra || '{}')?.original_song_url || ''
  } catch {
    return ''
  }
}

const normalizeForwardText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 构造合辑转发标题：@作者 作品描述 #标签，空字段不保留多余空格。 */
const buildDouyinForwardTitle = (aweme = {}) => {
  const description = normalizeForwardText(aweme.desc)
  const tags = []
  const addTag = (value) => {
    const tag = normalizeForwardText(String(value ?? '').replace(/^#+/, ''))
    if (tag && !tags.includes(tag)) tags.push(tag)
  }

  for (const item of aweme.text_extra || []) {
    if (item?.hashtag_name) addTag(item.hashtag_name)
  }

  // 兼容分享页/降级数据没有 text_extra 的情况，从作品描述中提取 #标签。
  const cleanDescription = description
    .replace(/#\s*([^\s#]+)/g, (_, tag) => {
      addTag(tag)
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()

  const author = normalizeForwardText(aweme.author?.nickname).replace(/^@+/, '')
  return [`@${author || '未知用户'}`, cleanDescription, tags.map((tag) => `#${tag}`).join(' ')]
    .filter(Boolean)
    .join(' ')
}

const getDouyinLiveVideoUrl = (imageItem) => {
  const uri = imageItem?.video?.play_addr_h264?.uri || imageItem?.video?.play_addr?.uri
  return uri ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0` : ''
}

/** 画质档位 → 目标视频高度（用于从 bit_rate 挑选最接近的码流） */
const getDouyinQualityHeight = (quality) => {
  const map = { '540p': 540, '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160 }
  return map[quality]
}

/** 画质档位 → aweme play 接口的 ratio 参数（分享页降级/无码流多档时用） */
const getDouyinQualityRatio = (quality) => {
  const map = { '540p': '540p', '720p': '720p', '1080p': '1080p', '2k': '1440p', '4k': '2160p' }
  return map[quality] || '1080p'
}

/** 码流高度 → ratio 参数（体积优先下调档位后按实际选中码流换算） */
const getDouyinHeightRatio = (height) => {
  if (height >= 1900) return '2160p'
  if (height >= 1400) return '1440p'
  if (height >= 1000) return '1080p'
  if (height >= 700) return '720p'
  if (height >= 500) return '540p'
  return '480p'
}

export class DouYin extends Base {
  /** @type {import('./getid.js').DouyinDataTypes[keyof import('./getid.js').DouyinDataTypes]} */
  type
  /** @type {boolean | undefined} */
  is_mp4
  /** @type {boolean} */
  is_slides
  /**
   * @typedef {Object} ExtendedDouyinIdData
   * @property {import('./getid.js').DouyinDataTypes[keyof import('./getid.js').DouyinDataTypes]} type
   * @property {boolean | undefined} is_mp4
   */

  /**
   * @param {*} e
   * @param {import('./getid.js').DouyinIdData & ExtendedDouyinIdData} iddata
   * @param {{ forceBurnDanmaku?: boolean }} [options]
   */
  constructor (e, iddata, options) {
    super(e)
    this.e = e
    this.type = iddata?.type
    this.is_mp4 = iddata?.is_mp4
    this.is_slides = false
    this.forceBurnDanmaku = options?.forceBurnDanmaku ?? false
    this.hasProcessedLiveImage = false
  }

  async handleArticleWork (VideoData) {
    const aweme = VideoData.data.aweme_detail
    const content = parseJsonSafely(aweme.article_info?.article_content)
    const feData = parseJsonSafely(aweme.article_info?.fe_data)
    const articleHtml = markdown(content.markdown || aweme.desc || '', {})

    const img = await Render('douyin/article-work', {
      title: aweme.article_info?.article_title || aweme.desc || '抖音文章',
      html: articleHtml,
      images: feData.image_list || [],
      read_time: feData.read_time || 0,
      dianzan: Common.count(aweme.statistics?.digg_count),
      pinglun: Common.count(aweme.statistics?.comment_count),
      shouchang: Common.count(aweme.statistics?.collect_count),
      share: Common.count(aweme.statistics?.share_count),
      create_time: Common.convertTimestampToDateTime(aweme.create_time),
      avater_url: getFirstUrl(aweme.author?.avatar_thumb) || getFirstUrl(aweme.author?.avatar_larger),
      username: aweme.author?.nickname || '无法获取',
      douyin_id: aweme.author?.unique_id || aweme.author?.short_id || '无法获取',
      total_favorited: Common.count(aweme.author?.total_favorited),
      following_count: Common.count(aweme.author?.following_count),
      follower_count: Common.count(aweme.author?.follower_count),
      share_url: aweme.share_url || `https://www.douyin.com/article/${aweme.aweme_id}`
    })
    await this.e.reply(img)
    return true
  }

  /**
   * @param {import('./getid.js').DouyinIdData} data 抖音数据
   * @returns {Promise<*>}
   */
  async RESOURCES (data) {
    try {
      if (this.type === 'undefined') return true
      (Config.app.parseTip || hasDouyinContent('提示信息')) && this.e.reply('检测到抖音链接，开始解析')
      switch (this.type) {
        case 'one_work': {
          // 同一作品多群转发时复用平台解析结果，避免重复请求聚合/评论 API（限流与延迟主因）
          const dataKey = `douyin:${data.aweme_id}`
          const VideoData = await runSingleFlightData(dataKey, async () => {
            const cached = getCachedData(dataKey)
            if (cached) return cached
            // 首选：浏览器环境请求 Web API（绕 Argus 风控，可获动图 clip_type/video 字段）
            // 已移除「聚合解析」首选：amagi 纯 HTTP 请求在此环境被抖音 Argus 风控稳定拦截，
            // 每次必然失败后降级，仅徒增失败请求与 WARN 日志；浏览器方案已覆盖详情获取。
            try {
              const browserData = await fetchDouyinDetailViaBrowser(data.aweme_id)
              if (browserData?.data?.aweme_detail != null) {
                browserData._source = 'browser'
                setCachedData(dataKey, browserData)
                return browserData
              }
              logger.warn(`[抖音] 浏览器解析返回空详情，降级分享页解析: ${data.aweme_id}`)
            } catch (error) {
              logger.warn(`[抖音] 浏览器解析失败，降级分享页解析: ${error?.message || error}`)
            }
            // 降级链路 2：浏览器不可用/失败时抓取分享页 HTML 中的 _ROUTER_DATA
            const shareData = await parseDouyinViaSharePage(data.aweme_id, Config.cookies.douyin || '')
            setCachedData(dataKey, shareData)
            return shareData
          })
          // 数据来源标记（多群并发单飞时仍能正确识别降级数据；降级链路不提供评论接口）
          const usedSharePage = VideoData?._source === 'sharePage' || VideoData?._source === 'browser'
          if (VideoData.data.aweme_detail === null) {
            throw new Error('获取作品详情失败，可能是因为该作品已被删除或设置为私密。')
          }
          const isArticle = isDouyinArticle(VideoData.data.aweme_detail)
          const isVideo = isDouyinVideo(VideoData.data.aweme_detail)
          if (typeof this.is_mp4 !== 'boolean') this.is_mp4 = isVideo
          // 降级时评论数据置空（分享页不提供评论接口），避免重复请求失败的 Web API
          const CommentsData = usedSharePage
            ? { data: { comments: [] } }
            : await runSingleFlightData(`${dataKey}:comments`, async () => {
              const cached = getCachedData(`${dataKey}:comments`)
              if (cached) return cached
              const fresh = await this.amagi.getDouyinData('评论数据', {
                aweme_id: data.aweme_id,
                number: Config.douyin.numcomments,
                typeMode: 'strict'
              })
              setCachedData(`${dataKey}:comments`, fresh)
              return fresh
            })
          this.is_slides = VideoData.data.aweme_detail.is_slides === true
          let g_video_url = ''
          let g_title

          /** 图集 */
          let imagenum = 0
          const image_res = []
          if (!isVideo && !isArticle && hasDouyinContent('图集')) {
            switch (true) {
              // 图集
              case this.is_slides === false && VideoData.data.aweme_detail.images !== null: {
                const image_data = []
                const imageres = []
                let image_url = ''
                // 使用可选链和空值合并操作符确保安全访问
                const images = VideoData.data.aweme_detail.images || []
                const hasLiveImage = images.some(item => (item.clip_type ?? 2) !== 2)
                const title = VideoData.data.aweme_detail.preview_title.substring(0, 50).replace(/[\\/:*?"<>|\r\n]/g, ' ')
                g_title = title

                if (hasLiveImage) {
                  const processedImages = []
                  const temp = []
                  let hasGeneratedLivePhoto = false
                  let bgmContext = null
                  const mergeMode = Config.douyin.liveImageMergeMode || 'independent'
                  const musicUrl = getDouyinMusicUrl(VideoData.data.aweme_detail.music)
                  const liveimgbgm = musicUrl
                    ? await downloadFile(musicUrl, {
                      title: `Douyin_tmp_A_${Date.now()}.mp3`,
                      headers: {
                        ...this.headers,
                        Referer: 'https://www.douyin.com/',
                        Cookie: ''
                      }
                    })
                    : null
                  if (liveimgbgm?.filepath) temp.push(liveimgbgm)

                  for (const [index, imageItem] of images.entries()) {
                    imagenum++
                    if (imageItem.clip_type === 2 || imageItem.clip_type === undefined) {
                      image_url = imageItem.url_list?.[2] || imageItem.url_list?.[1] || imageItem.url_list?.[0] || ''
                      const processedImageUrl = await processImageUrl(image_url, g_title, index, {
                        Referer: 'https://www.douyin.com/',
                        Cookie: Config.cookies.douyin || ''
                      })
                      processedImages.push(segment.image(processedImageUrl))
                      continue
                    }

                    const livePhoto = await buildLivePhotoMessages({
                      platform: 'douyin',
                      staticUrl: imageItem.url_list?.[0] || imageItem.url_list?.[2] || imageItem.url_list?.[1],
                      liveVideoUrl: getDouyinLiveVideoUrl(imageItem),
                      index,
                      total: images.length,
                      headers: {
                        ...this.headers,
                        Referer: 'https://www.douyin.com/',
                        Cookie: ''
                      },
                      bgmPath: liveimgbgm?.filepath,
                      mergeMode,
                      context: bgmContext,
                      loopCount: imageItem.clip_type === 4 ? 1 : 3
                    })
                    bgmContext = livePhoto.context || bgmContext
                    temp.push(...livePhoto.tempFiles)
                    hasGeneratedLivePhoto = hasGeneratedLivePhoto || livePhoto.generatedLivePhoto

                    if (livePhoto.messages.length > 0) {
                      processedImages.push(...livePhoto.messages)
                    } else if (imageItem.url_list?.[0]) {
                      const imageUrl = await processImageUrl(imageItem.url_list[0], g_title, index, {
                        Referer: 'https://www.douyin.com/',
                        Cookie: Config.cookies.douyin || ''
                      })
                      processedImages.push(segment.image(imageUrl))
                    }
                  }

                  if (hasGeneratedLivePhoto) processedImages.push(await buildLivePhotoTipMessage())
                  try {
                    for (const forward of await makeForwardMsgBatched(this.e, processedImages, '图集内容')) await this.e.reply(forward)
                  } finally {
                    for (const item of temp) await Common.removeFile(item.filepath, true)
                  }
                  this.hasProcessedLiveImage = true
                  break
                }

                for (const [index, imageItem] of images.entries()) {
                  // 获取图片地址，优先使用第三个URL，其次使用第二个URL
                  image_url = imageItem.url_list[2] || imageItem.url_list[1] || ''

                  // 处理标题，去除特殊字符
                  const processedImageUrl = await processImageUrl(image_url, title, index, {
                    Referer: 'https://www.douyin.com/',
                    Cookie: Config.cookies.douyin || ''
                  })
                  imageres.push(segment.image(processedImageUrl))
                  imagenum++

                  if (Config.app.removeCache === false) {
                    Common.mkdir(`${Common.tempDri.images}${g_title}`)
                    const path = `${Common.tempDri.images}${g_title}/${index + 1}.png`
                    await new Networks({ url: image_url, type: 'arraybuffer' }).getData().then((data) => fs.promises.writeFile(path, data))
                  }
                }
                const forwardTitle = buildDouyinForwardTitle(VideoData.data.aweme_detail)
                const forward = await makeForwardMsg(this.e, imageres, forwardTitle)
                image_data.push(forward)
                image_res.push(image_data)
                await this.e.reply(forward)
                break
              }
              // 合辑
              case VideoData.data.aweme_detail.is_slides === true && VideoData.data.aweme_detail.images !== null: {
                const images = []
                const temp = []
                let hasGeneratedLivePhoto = false
                let bgmContext = null
                const mergeMode = Config.douyin.liveImageMergeMode || 'independent'
                const musicUrl = getDouyinMusicUrl(VideoData.data.aweme_detail.music)
                const liveimgbgm = musicUrl
                  ? await downloadFile(musicUrl, {
                    title: `Douyin_tmp_A_${Date.now()}.mp3`,
                    headers: {
                      ...this.headers,
                      Referer: 'https://www.douyin.com/',
                      Cookie: ''
                    }
                  })
                  : null
                if (liveimgbgm?.filepath) temp.push(liveimgbgm)

                const images1 = VideoData.data.aweme_detail.images || []
                if (!images1.length) {
                  logger.debug('未获取到合辑的图片数据')
                }
                g_title = VideoData.data.aweme_detail.preview_title?.substring(0, 50).replace(/[\\/:*?"<>|\r\n]/g, ' ') || '抖音图集'
                const buildOneLiveImage = async (index) => {
                  const item = images1[index]
                  // 静态图片，clip_type为2或undefined
                  if (item.clip_type === 2 || item.clip_type === undefined) {
                    if (item.url_list[0]) {
                      const processedImageUrl = await processImageUrl(item.url_list[0], VideoData.data.aweme_detail.preview_title || '抖音图集', imagenum++, {
                        Referer: 'https://www.douyin.com/',
                        Cookie: Config.cookies.douyin || ''
                      })
                      return [segment.image(processedImageUrl)]
                    }
                    return []
                  }

                  const livePhoto = await buildLivePhotoMessages({
                    platform: 'douyin',
                    staticUrl: item.url_list?.[0] || item.url_list?.[2] || item.url_list?.[1],
                    liveVideoUrl: getDouyinLiveVideoUrl(item),
                    index,
                    total: images1.length,
                    headers: {
                      ...this.headers,
                      Referer: 'https://www.douyin.com/',
                      Cookie: ''
                    },
                    bgmPath: liveimgbgm?.filepath,
                    mergeMode,
                    context: bgmContext,
                    loopCount: item.clip_type === 4 ? 1 : 3
                  })
                  bgmContext = livePhoto.context || bgmContext
                  temp.push(...livePhoto.tempFiles)
                  hasGeneratedLivePhoto = hasGeneratedLivePhoto || livePhoto.generatedLivePhoto

                  if (livePhoto.messages.length > 0) return livePhoto.messages
                  if (item.url_list?.[0]) {
                    const imageUrl = await processImageUrl(item.url_list[0], g_title, index, {
                      Referer: 'https://www.douyin.com/',
                      Cookie: Config.cookies.douyin || ''
                    })
                    return [segment.image(imageUrl)]
                  }
                  return []
                }

                // 并行合成实况图，但按原始下标写回，保证最终发图顺序不变。
                // 连续 BGM 模式存在 bgmContext 前序依赖，必须串行，故并发放 1。
                const poolSize = mergeMode === 'continuous' ? 1 : Math.max(1, Number(Config.douyin.liveImageConcurrency) || 2)
                const built = new Array(images1.length)
                let poolCursor = 0
                const runLivePhotoWorker = async () => {
                  while (poolCursor < images1.length) {
                    const idx = poolCursor++
                    built[idx] = await buildOneLiveImage(idx)
                  }
                }
                await Promise.all(Array.from({ length: Math.min(poolSize, images1.length) }, () => runLivePhotoWorker()))
                images.push(...built.flat())
                if (hasGeneratedLivePhoto) images.push(await buildLivePhotoTipMessage())
                const forwardTitle = buildDouyinForwardTitle(VideoData.data.aweme_detail)
                const forwardList = await makeForwardMsgBatched(this.e, images, forwardTitle, 10, undefined, { titleOnce: true })
                try {
                  for (const forward of forwardList) await this.e.reply(forward)
                } catch (error) {
                  logger.error(error)
                } finally {
                  for (const item of temp) {
                    await Common.removeFile(item.filepath, true)
                  }
                }
                this.hasProcessedLiveImage = true
                break
              }
            }
          }

          /** 背景音乐 */
          if (!isArticle && VideoData.data.aweme_detail.music && hasDouyinContent('背景音乐') && !this.hasProcessedLiveImage) {
            const music = VideoData.data.aweme_detail.music
            const music_url = getDouyinMusicUrl(music) // BGM link
            if (this.is_mp4 === false && Config.app.removeCache === false && music_url !== undefined) {
              try {
                const path = Common.tempDri.images + `${g_title}/BGM.mp3`
                await new Networks({ url: music_url, type: 'arraybuffer' }).getData().then((data) => fs.promises.writeFile(path, data))
              } catch (error) {
                logger.error(error)
              }
            }
            const haspath = music_url && this.is_mp4 === false && music_url !== undefined
            if (haspath) {
              await this.e.reply(await UploadRecord(this.e, music_url, 0, Config.douyin.sendHDrecord ? false : true))
            }
          }

          /** 视频 */
          let FPS
          const sendvideofile = true
          let video = null
          let cover = ''
          let sourceIndex = 0
          volumeAdjusted = false
          mp4sizeSet = ''
          if (isVideo) {
            // 视频地址特殊判断：play_addr_h264、play_addr、
            video = VideoData.data.aweme_detail.video
            FPS = video.bit_rate[sourceIndex]?.FPS || '获取失败' // FPS
            if (Config.douyin.autoResolution) {
              logger.debug(`开始排除不符合条件的视频分辨率；\n
              共拥有${logger.yellow(video.bit_rate.length)}个视频源\n
              视频ID：${logger.green(VideoData.data.aweme_detail.aweme_id)}\n
              分享链接：${logger.green(VideoData.data.aweme_detail.share_url)}
              `)
              // 体积上限下载：按 douyin.maxAutoVideoSize 筛选可下载的视频流（根据大小自动选择模式）
              const sizeLimitMb = Config.douyin.maxAutoVideoSize || 100
              mp4sizeLimit = sizeLimitMb
              const limitBytes = sizeLimitMb * 1024 * 1024
              const usableStreams = (video.bit_rate || []).filter(item => item.format !== 'dash')
              // 体积优先+具体档位：保留完整码流列表以便后续下调档位，不在此做单流折叠
              const volPriTier = Config.douyin.volumePriority && !!getDouyinQualityHeight(Config.douyin.videoQuality)
              if (!volPriTier) {
                mp4sizeExceeded = usableStreams.length > 0 && usableStreams.every(item => (item.play_addr?.data_size || 0) > limitBytes)
                video.bit_rate = douyinProcessVideos(video.bit_rate, sizeLimitMb)
              } else {
                mp4sizeExceeded = false
              }
            }
            // 视频地址按适配器分支：
            // - QQBot：官方 bot 用裸请求抓取视频 URL，私有 CDN 长链会 403，故用 aweme.snssdk.com 无签名 play 直链（kkk 原方式）
            // - OneBot 等：平台 API 下载带 Referer，能正常拉取 CDN 长链，用 astr 的 getLongLink() 跟随重定向得到可下载直链
            if (Config.douyin.videoQuality === 'hdr' && video.bit_rate?.length) {
              // 优先选择 HDR 码流（hdr_type 非 0），无 HDR 源时回退首条，避免解析失败
              const hdrIndex = video.bit_rate.findIndex(item => item.hdr_type || item.play_addr?.hdr_type)
              if (hdrIndex >= 0) sourceIndex = hdrIndex
            } else if (Config.douyin.videoQuality && Config.douyin.videoQuality !== 'adapt') {
              // 按画质配置从 bit_rate 选取高度最接近目标档的码流；匹配不到则保持默认首条，避免越级
              const target = getDouyinQualityHeight(Config.douyin.videoQuality)
              if (target && video.bit_rate?.length) {
                let best = { d: Infinity, i: sourceIndex }
                for (let i = 0; i < video.bit_rate.length; i++) {
                  const h = video.bit_rate[i]?.play_addr?.height || 0
                  if (h <= 0) continue
                  const d = Math.abs(h - target)
                  if (d < best.d) best = { d, i }
                }
                sourceIndex = best.i
              }
              // 记录设定档位体积（下调前所选码流），供信息图显示“实际解析体积 设定档位体积/限制体积”
              mp4sizeSet = ((video.bit_rate[sourceIndex]?.play_addr?.data_size || 0) / (1024 * 1024)).toFixed(2)
              // 体积优先：设置具体档位时，若该档位体积超过 maxAutoVideoSize 则自动下调到能发出的档位
              if (Config.douyin.volumePriority && video.bit_rate?.length) {
                mp4sizeLimit = Config.douyin.maxAutoVideoSize || 100
                const vpLimitBytes = mp4sizeLimit * 1024 * 1024
                const candidates = video.bit_rate.filter(item => item.format !== 'dash' && (item.play_addr?.data_size || 0) > 0)
                if (candidates.length) {
                  const chosenBytes = video.bit_rate[sourceIndex]?.play_addr?.data_size || 0
                  if (chosenBytes > vpLimitBytes) {
                    const fit = candidates.filter(c => (c.play_addr?.data_size || 0) <= vpLimitBytes)
                    const pool = fit.length ? fit : candidates
                    const byRes = (c) => (c.play_addr?.height || 0) || (c.play_addr?.width || 0) || 0
                    const pick = fit.length
                      ? pool.reduce((a, b) => (byRes(b) > byRes(a) ? b : a))
                      : pool.reduce((a, b) => ((b.play_addr?.data_size || 0) < (a.play_addr?.data_size || 0) ? b : a))
                    const realIdx = video.bit_rate.indexOf(pick)
                    if (realIdx >= 0) {
                      sourceIndex = realIdx
                      volumeAdjusted = true
                      mp4sizeExceeded = false
                    }
                  }
                }
              }
            }
            // 体积优先下调档位后，下载与展示均跟随实际选中码流：ratio 按所选码流高度换算，OneBot 直接走所选码流 CDN 直链
            let playRatio = getDouyinQualityRatio(Config.douyin.videoQuality)
            if (volumeAdjusted) {
              playRatio = getDouyinHeightRatio(video.bit_rate[sourceIndex]?.play_addr?.height || 0)
            }
            const rb = (video.bit_rate && video.bit_rate.length ? video.bit_rate[sourceIndex].play_addr : null) || video.play_addr_h264 || video.play_addr
            if (this.botadapter === 'QQBot') {
              const playUri = rb?.uri || video.play_addr?.uri || ''
              g_video_url = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${playUri}&ratio=${playRatio}&line=0`
            } else {
              // OneBot：配置了具体画质档时用 aweme play 的 ratio 参数强制清晰度（bit_rate 各档 height 多为相同值/缺失，按高度挑档不可靠）；
              // 未配置具体档（adapt/hdr）或体积优先已下调档位则沿用所选码流 CDN 签名长链，最大化兼容
              const configuredQ = Config.douyin.videoQuality
              const useRatioEndpoint = playRatio && configuredQ && configuredQ !== 'adapt' && configuredQ !== 'hdr' && !volumeAdjusted && rb?.uri
              if (useRatioEndpoint) {
                g_video_url = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${rb.uri}&ratio=${playRatio}&line=0`
              } else {
                g_video_url = await new Networks({
                  url: rb?.url_list?.[1] || rb?.url_list?.[0],
                  headers: {
                    ...this.headers,
                    Referer: rb?.url_list?.[0] || 'https://www.douyin.com/',
                    Cookie: ''
                  }
                }).getLongLink()
              }
            }
            cover = getFirstUrl(video.animated_cover) || getFirstUrl(video.dynamic_cover) || getFirstUrl(video.cover_original_scale) || getFirstUrl(video.cover) || getFirstUrl(video.origin_cover)

            const title = VideoData.data.aweme_detail.preview_title.substring(0, 80).replace(/[\\/:\*\?"<>\|\r\n]/g, ' ') // video title
            g_title = title
            // 文件大小：配置了具体画质档时按目标档与原画高的比例折算展示，避免仍显示为最高档大小
            const szQ = Config.douyin?.videoQuality
            const szQH = getDouyinQualityHeight(szQ)
            const szSrcH = video.height || 0
            const szFixed = szQ && szQ !== 'adapt' && szQ !== 'hdr' && szQH > 0 && szSrcH > 0
            const szScale = szFixed ? Math.min(1, szQH / szSrcH) : 1
            // 体积优先下调档位后，直接采用所选码流的实际大小
            mp4size = (((video.bit_rate[sourceIndex]?.play_addr?.data_size || 0) * (volumeAdjusted ? 1 : szScale)) / (1024 * 1024)).toFixed(2)
            // 实际解析体积（字节）：分享页降级等 data_size 缺失时为 0，需远程探测补充用于体积展示与配额预估
            parsedDataSize = video.bit_rate?.[sourceIndex]?.play_addr?.data_size || 0
            if (!parsedDataSize && g_video_url) {
              const probed = await getRemoteFileSize(g_video_url, {
                ...baseHeaders,
                Referer: g_video_url
              })
              if (probed > 0) {
                parsedDataSize = probed
                mp4size = (probed / (1024 * 1024)).toFixed(2)
              }
            }
            logger.info('视频地址', `https://aweme.snssdk.com/aweme/v1/play/?video_id=${VideoData.data.aweme_detail.video.play_addr.uri}&ratio=1080p&line=0`)
          }

          if (isVideo && hasDouyinContent('视频', 'info')) {
            const aweme = VideoData.data.aweme_detail
            const statistics = aweme.statistics || {}
            const displayContent = Config.douyin.displayContent || ['cover', 'title', 'author', 'stats']
            if (Config.douyin.videoInfoMode === 'text') {
              const processedCover = await processImageUrl(cover, aweme.desc || g_title || '抖音视频封面', 0, {
                Referer: 'https://www.douyin.com/',
                Cookie: Config.cookies.douyin || ''
              })
              const contentMap = {
                cover: segment.image(processedCover),
                title: `\n标题：${aweme.desc || g_title}\n`,
                author: `\n作者：${aweme.author?.nickname || '无法获取'}\n`,
                stats: formatVideoStats(statistics)
              }
              const replyContent = []
              for (const item of ['cover', 'title', 'author', 'stats']) {
                if (displayContent.includes(item) && contentMap[item]) replyContent.push(contentMap[item])
              }
              if (replyContent.length) await this.e.reply(replyContent)
            } else {
              let userProfile
              try {
                // 作者资料缓存：同一作者的作品被持续转发时复用其主页数据，避免重复请求作者 API
                const authorKey = `douyin:author:${aweme.author.sec_uid}`
                userProfile = await runSingleFlightData(authorKey, async () => {
                  const cachedProfile = getCachedData(authorKey)
                  if (cachedProfile) return cachedProfile
                  const fresh = await this.amagi.getDouyinData('用户主页数据', {
                    sec_uid: aweme.author.sec_uid,
                    typeMode: 'strict'
                  })
                  const profile = fresh?.data?.user
                  if (profile) setCachedData(authorKey, profile)
                  return profile
                })
              } catch (error) {
                logger.warn('[抖音] 获取作者主页信息失败，继续渲染视频信息图', error)
              }
              const userProfileView = userProfile
                ? {
                  ip_location: userProfile.ip_location,
                  follower_count: Common.count(userProfile.follower_count),
                  total_favorited: Common.count(userProfile.total_favorited),
                  aweme_count: Common.count(userProfile.aweme_count)
                }
                : undefined
              const musicInfo = aweme.music
                ? {
                  author: aweme.music.author,
                  title: aweme.music.title,
                  cover: getFirstUrl(aweme.music.cover_hd) || getFirstUrl(aweme.music.cover_large) || getFirstUrl(aweme.music.cover_thumb)
                }
                : undefined
              const selectedVideo = video.bit_rate?.[sourceIndex]
              // 展示实际选中码流/目标档的宽高，使信息图与实际下载的清晰度一致。
              // 配置了具体画质档时直接按目标档等比换算（bit_rate 各档 height 不可靠，避免误显示为原画最高档）
              const cfgQ = Config.douyin?.videoQuality
              const qH = getDouyinQualityHeight(cfgQ)
              const sh = selectedVideo?.play_addr?.height
              const srcH = video.height || sh || 0
              const cfgFixed = cfgQ && cfgQ !== 'adapt' && cfgQ !== 'hdr' && qH > 0 && srcH > 0
              // 体积优先下调档位后，分辨率展示所选码流的实际宽高，与下载一致
              const showH = volumeAdjusted
                ? ((sh && sh > 0) ? sh : srcH)
                : (cfgFixed ? Math.min(qH, srcH) : ((sh && sh > 0) ? sh : video.height))
              const showW = volumeAdjusted
                ? (selectedVideo?.play_addr?.width || video.width)
                : (cfgFixed
                  ? Math.round((video.width || srcH) * showH / srcH)
                  : (selectedVideo?.play_addr?.width || video.width))
              const videoInfo = video
                ? {
                  duration: formatVideoDuration(video.duration),
                  // 展示实际选中码流的宽高，与下载一致的清晰度，避免仍显示最高档
                  width: showW,
                  height: showH,
                  ratio: video.ratio,
                  isHdr: (() => {
                    const src = video.bit_rate
                    const hdrOf = (item) => item?.HDR_type || item?.hdr_type || item?.play_addr?.hdr_type
                    return hdrOf(video.bit_rate?.[sourceIndex]) || src?.some(hdrOf) || false
                  })(),
                  size: mp4size,
                  sizeExceeded: mp4sizeExceeded,
                  sizeLimit: mp4sizeLimit,
                  sizeSet: mp4sizeSet,
                  volumeAdjusted
                }
                : undefined
              const desc = aweme.desc || g_title
              // 从标题中提取 #话题 标签（# 后跟随非空格非#的连续字符），正文去掉标签保持整洁
              const hashtags = [...new Set((desc.match(/#[^\s#]+/g) || []).map((h) => h.slice(1)))]
              const cleanDesc = desc.replace(/#[^\s#]+/g, '').replace(/[ \t]+/g, ' ').trim()
              const videoInfoImg = await Render('douyin/videoInfo', {
                desc: cleanDesc,
                hashtags,
                aweme_id: aweme.aweme_id,
                share_url: aweme.share_url,
                image_url: cover,
                create_time: Common.convertTimestampToDateTime(aweme.create_time),
                showCover: displayContent.includes('cover'),
                showTitle: displayContent.includes('title'),
                showAuthor: displayContent.includes('author'),
                showStats: displayContent.includes('stats'),
                statistics: {
                  digg_count: Common.count(statistics.digg_count),
                  comment_count: Common.count(statistics.comment_count),
                  collect_count: Common.count(statistics.collect_count),
                  share_count: Common.count(statistics.share_count),
                  recommend_count: Common.count(statistics.recommend_count),
                  ...(statistics.play_count !== undefined ? { play_count: Common.count(statistics.play_count) } : {})
                },
                author: {
                  name: aweme.author?.nickname || '无法获取',
                  avatar: getFirstUrl(aweme.author?.avatar_thumb) || getFirstUrl(aweme.author?.avatar_larger),
                  short_id: aweme.author?.unique_id || aweme.author?.short_id || '无法获取'
                },
                user_profile: userProfileView,
                music: musicInfo,
                video: videoInfo,
                quotaInfo: getQuotaInfo(this.e, parsedDataSize || video.bit_rate?.[sourceIndex]?.play_addr?.data_size || 0)
              })
              await this.e.reply(videoInfoImg)
            }
          }

          /** 发送视频 */
          if (isVideo && hasDouyinContent('视频', 'video') && sendvideofile && !mp4sizeExceeded) {
            let danmakuList = []
            const sendOriginalVideo = async () => {
              await downloadVideo(
                this.e,
                {
                  video_url: g_video_url,
                  title: {
                    timestampTitle: `tmp_${Date.now()}.mp4`,
                    originTitle: `${g_title}.mp4`
                  },
                  headers: {
                    ...baseHeaders,
                    Referer: g_video_url,
                    Cookies: ''
                  },
                  cacheKey: `douyin:${VideoData.data.aweme_detail?.aweme_id || g_video_url}`
                },
                {
                  message_id: this.e.message_id
                }
              )
            }

            if (this.forceBurnDanmaku || Config.douyin.burnDanmaku) {
              try {
                const danmakuData = await this.amagi.getDouyinData('弹幕数据', {
                  aweme_id: data.aweme_id,
                  duration: video.duration,
                  typeMode: 'strict'
                })
                danmakuList = danmakuData?.data?.danmaku_list || danmakuData?.danmaku_list || []
                logger.debug(`[抖音] 获取到 ${danmakuList.length} 条弹幕`)
              } catch (error) {
                logger.warn('[抖音] 获取弹幕失败，将发送原视频', error)
              }
            }

            if ((this.forceBurnDanmaku || Config.douyin.burnDanmaku) && danmakuList.length > 0) {
              const videoFile = await downloadFile(g_video_url, {
                title: `Douyin_V_tmp_${Date.now()}.mp4`,
                headers: {
                  ...baseHeaders,
                  Referer: 'https://www.douyin.com'
                }
              })
              if (videoFile.filepath) {
                const resultPath = Common.tempDri.video + `Douyin_Danmaku_${Date.now()}.mp4`
                const ok = await burnDanmaku('douyin', videoFile.filepath, danmakuList, resultPath, {
                  danmakuArea: Config.douyin.danmakuArea,
                  danmakuFontSize: Config.douyin.danmakuFontSize,
                  danmakuOpacity: Config.douyin.danmakuOpacity
                })
                await Common.removeFile(videoFile.filepath, true)
                if (ok) {
                  const size = await Common.getVideoFileSize(resultPath)
                  await uploadFile(this.e, { filepath: resultPath, totalBytes: size, originTitle: g_title }, '')
                } else {
                  await sendOriginalVideo()
                }
              } else {
                await sendOriginalVideo()
              }
            } else {
              await sendOriginalVideo()
            }
          }

          if (isArticle) {
            await this.handleArticleWork(VideoData)
          }

          if (hasDouyinContent('评论图', 'comment')) {
            // 分享页降级时评论数据为空，直接提示，避免再请求可能失败的 Web API
            if (usedSharePage) {
              await this.e.reply('这个作品没有评论 ~')
            } else {
              const EmojiData = await this.amagi.getDouyinData('Emoji数据', { typeMode: 'strict' })
              const list = Emoji(EmojiData.data)
              const commentsArray = await douyinComments(CommentsData, list)
              if (!commentsArray?.jsonArray?.length) {
                await this.e.reply('这个作品没有评论 ~')
              } else {
                const img = await Render('douyin/comment',
                  {
                    Type: isArticle ? '文章' : isVideo ? '视频' : this.is_slides ? '合辑' : '图集',
                    CommentsData: commentsArray,
                    CommentLength: Config.douyin.realCommentCount ? VideoData.data.aweme_detail.statistics.comment_count : commentsArray.jsonArray?.length ?? 0,
                    share_url: this.is_mp4
                      ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${VideoData.data.aweme_detail.video.play_addr.uri}&ratio=1080p&line=0`
                      : VideoData.data.aweme_detail.share_url,
                    Title: g_title,
                    VideoSize: mp4size,
                    VideoFPS: FPS,
                    ImageLength: imagenum
                  }
                )
                await this.e.reply(img)
              }
            }
          }
          return true
        }

        case 'user_dynamic': {
          const UserVideoListData = await this.amagi.getDouyinData('用户主页视频列表数据', {
            sec_uid: data.sec_uid,
            typeMode: 'strict'
          })
          const UserInfoData = await this.amagi.getDouyinData('用户主页数据', {
            sec_uid: data.sec_uid,
            typeMode: 'strict'
          })

          const awemeList = UserVideoListData?.data?.aweme_list || UserVideoListData?.aweme_list || []
          const user = UserInfoData?.data?.user || {}
          const timeoutSeconds = 120
          const displayVideos = awemeList.slice(0, 16).map((aweme, index) => {
            const isVideo = isDouyinVideo(aweme)
            return {
              aweme_id: aweme.aweme_id,
              index: index + 1,
              title: aweme.desc || aweme.item_title || '无标题',
              cover: getDouyinWorkCoverUrl(aweme),
              duration: aweme.video?.duration || 0,
              create_time: Common.convertTimestampToDateTime(aweme.create_time),
              is_top: aweme.is_top === 1,
              is_video: isVideo,
              type_text: isVideo ? '视频' : isDouyinArticle(aweme) ? '文章' : '图集',
              statistics: {
                like_count: Common.count(aweme.statistics?.digg_count),
                comment_count: Common.count(aweme.statistics?.comment_count),
                share_count: Common.count(aweme.statistics?.share_count),
                collect_count: Common.count(aweme.statistics?.collect_count)
              },
              music: aweme.music
                ? {
                  title: aweme.music.title || '',
                  author: aweme.music.author || ''
                }
                : undefined
            }
          })

          const img = await Render('douyin/user_profile', {
            user: {
              head_image: user.cover_and_head_image_info?.profile_cover_list?.[0]?.cover_url?.url_list?.[0] || '',
              nickname: user.nickname || '未知用户',
              short_id: user.unique_id || user.short_id || '无法获取',
              avatar: user.avatar_larger?.url_list?.[0] || user.avatar_thumb?.url_list?.[0] || '',
              signature: user.signature || '这个用户很懒，还没有签名',
              follower_count: Common.count(user.follower_count),
              following_count: Common.count(user.following_count),
              total_favorited: Common.count(user.total_favorited),
              verified: Boolean(user.custom_verify || user.enterprise_verify_reason),
              ip_location: user.ip_location || ''
            },
            videos: displayVideos,
            timeoutSeconds
          })
          img && await this.e.reply(img)
          if (!displayVideos.length) return true
          return {
            type: 'douyin_user_selection',
            timeoutSeconds,
            videos: displayVideos.map(item => ({
              aweme_id: item.aweme_id,
              title: item.title,
              index: item.index
            }))
          }
        }
        case 'music_work': {
          const MusicData = await this.amagi.getDouyinData('音乐数据', {
            music_id: data.music_id,
            typeMode: 'strict'
          })
          const sec_uid = MusicData.data.music_info.sec_uid
          const UserData = await this.amagi.getDouyinData('用户主页数据', { sec_uid, typeMode: 'strict' })
          // if (userdata.status_code === 2) {
          //   const new_userdata = await getDouyinData('搜索数据', { query: data.music_info.author })
          //   if (new_userdata.data[0].type === 4 && new_userdata.data[0].card_unique_name === 'user') {
          //     userdata = { user: new_userdata.data[0].user_list[0].user_info }
          //   }
          //   const search_data = new_userdata
          // }
          if (!MusicData.data.music_info.play_url) {
            await this.e.reply('解析错误！该音乐抖音未提供下载链接，无法下载', { reply: true })
            return true
          }
          img = await Render('douyin/musicinfo',
            {
              image_url: MusicData.data.music_info.cover_hd.url_list[0],
              desc: MusicData.data.music_info.title,
              music_id: MusicData.data.music_info.id,
              create_time: Time(0),
              user_count: Common.count(MusicData.data.music_info.user_count),
              avater_url: MusicData.data.music_info.avatar_large?.url_list[0] || UserData.data.user.avatar_larger.url_list[0],
              fans: UserData.data.user.mplatform_followers_count || UserData.data.user.follower_count,
              following_count: UserData.data.user.following_count,
              total_favorited: UserData.data.user.total_favorited,
              user_shortid: UserData.data.user.unique_id === '' ? UserData.data.user.short_id : UserData.data.user.unique_id,
              share_url: MusicData.data.music_info.play_url.uri,
              username: MusicData.data.music_info?.original_musician_display_name || MusicData.data.music_info.owner_nickname === '' ? MusicData.data.music_info.author : MusicData.data.music_info.owner_nickname
            }
          )
          await this.e.reply(
            this.mkMsg(
              [
                ...img,
                `\n正在上传 ${MusicData.data.music_info.title}\n`,
                `作曲: ${MusicData.data.music_info.original_musician_display_name || MusicData.data.music_info.owner_nickname === '' ? MusicData.data.music_info.author : MusicData.data.music_info.owner_nickname}\n`,
                `music_id: ${MusicData.data.music_info.id}\n`,
                `BGM_Id: ${data.music_id}`
              ],
              [{ text: '音乐文件', link: MusicData.data.music_info.play_url.uri }]
            )
          )
          await this.e.reply(await UploadRecord(this.e, MusicData.data.music_info.play_url.uri, 0, Config.douyin.sendHDrecord ? false : true))
          return true
        }
        case 'live_room_detail': {
          const UserInfoData = await this.amagi.getDouyinData('用户主页数据', {
            sec_uid: data.sec_uid,
            typeMode: 'strict'
          })
          if (UserInfoData.data.user.live_status === 1) {
            // 直播中
            const live_data = await this.amagi.getDouyinData('直播间信息数据', { sec_uid: UserInfoData.data.user.sec_uid, typeMode: 'strict' })
            const room_data = JSON.parse(UserInfoData.data.user.room_data)
            const img = await Render('douyin/live',
              {
                image_url: [{ image_src: live_data.data.data[0].cover?.url_list[0] }],
                text: live_data.data.data[0].title,
                liveinf: `${live_data.data.partition_road_map.partition.title} | 房间号: ${room_data.owner.web_rid}`,
                在线观众: Common.count(Number(live_data.data.data[0].room_view_stats?.display_value)),
                总观看次数: Common.count(Number(live_data.data.data[0].stats?.total_user_str)),
                username: UserInfoData.data.user.nickname,
                avater_url: UserInfoData.data.user.avatar_larger.url_list[0],
                fans: Common.count(UserInfoData.data.user.follower_count),
                create_time: Common.convertTimestampToDateTime(new Date().getTime()),
                now_time: Common.convertTimestampToDateTime(new Date().getTime()),
                share_url: 'https://live.douyin.com/' + room_data.owner.web_rid,
                dynamicTYPE: '直播间信息'
              }
            )
            await this.e.reply(img)
          } else {
            await this.e.reply(`「${UserInfoData.data.user.nickname}」\n未开播，正在休息中~`)
          }
          return true
        }
        default:
          break
      }
    } catch (e) {
      logger.warn(`抖音解析错误：${e}`)
      return false
    }
  }

}

/**
 * 处理抖音视频数据，根据大小限制筛选合适的视频
 * @param {dyVideo[]} videos - 视频数组
 * @param {number} filelimit - 文件大小限制(MB)
 * @returns {dyVideo[]} 处理后的视频数组，只包含一个最合适的视频
 */
export const douyinProcessVideos = (videos, filelimit) => {
  const sizeLimitBytes = filelimit * 1024 * 1024 // 将 MB 转换为字节
  logger.debug(videos)
  // 过滤掉 format 为 'dash' 的视频，并且过滤出小于等于大小限制的视频
  const validVideos = videos.filter(video => video.format !== 'dash' && video.play_addr.data_size <= sizeLimitBytes)

  if (validVideos.length > 0) {
    // 如果有符合条件的视频，找到 data_size 最大的视频
    return [validVideos.reduce((maxVideo, currentVideo) => {
      return currentVideo.play_addr.data_size > maxVideo.play_addr.data_size ? currentVideo : maxVideo
    })]
  } else {
    // 如果没有符合条件的视频，返回 data_size 最小的那个视频（排除 'dash' 格式）
    const allValidVideos = videos.filter(video => video.format !== 'dash')
    return [allValidVideos.reduce((minVideo, currentVideo) => {
      return currentVideo.play_addr.data_size < minVideo.play_addr.data_size ? currentVideo : minVideo
    })]
  }
}

/**
 * 传递整数，返回x小时后的时间
 * @param {number} delay - 延迟的小时数
 * @returns {string} - 返回格式化后的时间字符串
 */
function Time (delay) {
  const currentDate = new Date()
  currentDate.setHours(currentDate.getHours() + delay)

  const year = currentDate.getFullYear().toString()
  const month = (currentDate.getMonth() + 1).toString()
  const day = String(currentDate.getDate()).padStart(2, '0')
  const hours = String(currentDate.getHours()).padStart(2, '0')
  const minutes = String(currentDate.getMinutes()).padStart(2, '0')
  const seconds = String(currentDate.getSeconds()).padStart(2, '0')

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
}

/**
 * 处理抖音表情数据
 * @param {import('@ikenxuan/amagi').DyEmojiList} data 表情数据对象
 * @returns {Array<{name: string, url: string | undefined}>} 处理后的表情数组,包含name和url属性
 */
export const Emoji = (data) => {
  const ListArray = []

  for (const i of data.emoji_list) {
    const display_name = i.display_name
    const url = i.emoji_url.url_list[0]

    const Objject = {
      name: display_name,
      url
    }
    ListArray.push(Objject)
  }
  return ListArray
}
