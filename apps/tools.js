import { KuaiShou, GetKuaishouID, KuaishouData } from '../module/platform/kuaishou/index.js'
import { Bilibili, getBilibiliID } from '../module/platform/bilibili/index.js'
import { DouYin, getDouyinID } from '../module/platform/douyin/index.js'
import { Xiaohongshu, getXiaohongshuID } from '../module/platform/xiaohongshu/index.js'
import { Config, Common, UploadRecord, wrapWithErrorHandler, downloadVideo, baseHeaders } from '../module/utils/index.js'
import { arbitrationShouldParse, markParseFailed } from '../module/utils/EmojiReaction.js'
import { douyinParseQueue, bilibiliParseQueue, kuaishouParseQueue, xiaohongshuParseQueue } from '../module/utils/ConcurrencyQueue.js'
import { getStatisticsDB } from '../module/db/index.js'
import { getDouyinData } from '../module/platform/douyin/api.js'

// 用户状态存储对象
const user = {}
const douyinSelections = new Map()
const tierSelections = new Map()

// 档位命令：#前缀可选，支持 xk解析档位 / xk档位解析 / 解析档位 / 档位解析 / xk档位
const TIER_COMMAND_REG = /^#?(?:xk解析档位|xk档位解析|解析档位|档位解析|xk档位)/

const getConfigValue = (value, fallback) => value ?? fallback
const isVideoToolEnabled = () => getConfigValue(Config.app?.videoTool, Config.app?.videotool) !== false
const isDefaultTool = () => getConfigValue(Config.app?.defaulttool, Config.app?.videoTool) !== false
// 私聊解析开关；onebot/qqbot 私聊事件字段存在差异，故兼容多种私聊标记
const isPrivateParseEnabled = () => getConfigValue(Config.app?.privateTool, true) !== false
const isPrivateEvent = e => Boolean(
  e?.isPrivate || e?.is_private || e?.message_type === 'private' || e?.isGroup === false
)

const PLATFORM_CONFIG = [
  {
    reg: /.*((www|v|jx|jingxuan|m)\.(douyin|iesdouyin)\.com|douyin\.com\/(video|note)).*/i,
    handler: 'douyin',
    enabled: getConfigValue(Config.douyin?.switch, Config.douyin?.douyintool)
  },
  {
    reg: /(bilibili.com|b23.tv|t.bilibili.com|bili2233.cn|^BV[1-9a-zA-Z]{10}$|^av\d+$)/i,
    handler: 'bilibili',
    enabled: getConfigValue(Config.bilibili?.switch, Config.bilibili?.bilibilitool)
  },
  {
    reg: /^((.*)快手(.*)快手(.*)|(.*)v\.kuaishou(.*)|(.*)kuaishou\.com\/f\/[a-zA-Z0-9]+.*)$/,
    handler: 'kuaishou',
    enabled: getConfigValue(Config.kuaishou?.switch, Config.kuaishou?.kuaishoutool)
  },
  {
    reg: /(xiaohongshu\.com|xhslink\.c(?:n|om))/i,
    handler: 'xiaohongshu',
    enabled: Config.xiaohongshu?.switch
  }
]

/**
 * 动态生成插件规则
 * @returns {Array} 返回启用的平台规则数组
 */
const generateRules = () => isVideoToolEnabled()
  ? PLATFORM_CONFIG
    .filter(config => config.enabled)
    .map(({ reg, handler }) => ({ reg, fnc: handler }))
  : []

const findPlatformConfig = msg => PLATFORM_CONFIG.find(config => config.enabled && config.reg.test(msg || ''))
const getEventUserId = e => String(e.user_id || e.userId || e.sender?.user_id || e.sender?.userId || 'unknown')
const getEventGroupId = e => String(e.group_id || e.groupId || 'private')
const getSelectionKey = e => `${getEventGroupId(e)}:${getEventUserId(e)}`

const recordParseStatistics = async (e, platform) => {
  const groupId = String(e.group_id || e.groupId || 'private')
  const userId = String(e.user_id || e.userId || e.sender?.user_id || e.sender?.userId || 'unknown')
  try {
    const statisticsDB = await getStatisticsDB()
    await statisticsDB?.recordParse(groupId, userId, platform)
  } catch (error) {
    logger.error('[统计] 记录解析统计失败', error)
  }
}

export class kkkTools extends plugin {
  constructor() {
    super({
      name: 'kkkkkk-10086-视频功能',
      dsc: '视频',
      event: 'message',
      priority: isDefaultTool() ? -Infinity : Config.app.priority,
      rule: [
        { reg: TIER_COMMAND_REG, fnc: 'tierParse' }, // 档位选择命令，须优先于平台链接规则，避免被当作普通解析
        ...generateRules(), // 动态生成的平台规则
        ...(isVideoToolEnabled() ? [{ reg: /^(\[图片\])?$/, fnc: 'imageQrCode' }] : []),
        { reg: /^#?\d{1,2}$/, fnc: 'selectDouyinWork' },
        { reg: /^#?(?:解析|xk解析|弹幕解析|xk弹幕解析)(?!帮助|版本|更新|删除缓存|统计|设置)/, fnc: 'prefix' }, // 解析功能规则（排除帮助/版本/更新/删除缓存/统计等指令，避免吞掉其他功能）
        { reg: /#?BGM(\d+)/, fnc: 'uploadRecord' }, // BGM上传功能规则
        { reg: /^#?第(\d{1,3})集$/, fnc: 'next' } // 选集功能规则
      ]
    })
  }

  /**
   * 统一处理不同平台的链接解析
   * @param {any} e 事件对象
   * @returns {Promise<boolean>} 处理结果
   */
  /**
   * 惰解析群：列表中的群必须带解析指令才解析，裸链接/纯图片不自动解析
   * @param {any} e 事件对象
   * @param {string} name 平台名称（仅用于日志）
   * @returns {boolean} true 表示应拦截（跳过解析）
   */
  _shouldManualParseBlock(e, name) {
    // 显式带了解析指令（经由 prefix 指令入口进入）则放行
    if (e._xkCommandParse) return false
    const advanced = Config.advanced || {}
    if (!advanced.manualParseEnabled) return false
    const groups = (advanced.manualParseGroups || []).map(g => String(g))
    if (!groups.includes(getEventGroupId(e))) return false
    // 消息本身已含解析指令时也放行（如“xk解析 链接”被平台规则先命中）
    if (/^#?(?:解析|xk解析|弹幕解析|xk弹幕解析)/.test(e.msg || '')) return false
    logger.info(`[惰解析群] 群${getEventGroupId(e)}在惰解析列表，需带指令才解析，跳过${name}自动解析`)
    return true
  }

  async prefix(e) {
    const originalMsg = e.msg || ''
    // 命中本规则即代表用户显式使用了解析指令，标记为指令解析
    e._xkCommandParse = true
    e.msg = await Common.getReplyMessage(e)
    logger.info(`[解析][DEBUG] prefix后 e.msg=${JSON.stringify(String(e.msg || '')).slice(0, 180)}`)

    // xk解析档位：列出全部清晰度档位供选择下载
    if (TIER_COMMAND_REG.test(originalMsg)) {
      e._xkTierCommand = true
    }

    if (/^#?(弹幕解析|xk弹幕解析)/.test(originalMsg)) {
      e.msg = `#弹幕解析 ${e.msg}`
    }

    if (/https:\/\/aweme\.snssdk\.com\/aweme\/v1\/play/i.test(e.msg)) {
      const videoId = e.msg.match(/video_id=([^&\s]+)/)?.[1] || Date.now().toString()
      await downloadVideo(e, {
        video_url: e.msg,
        title: {
          timestampTitle: `tmp_${Date.now()}.mp4`,
          originTitle: `抖音视频_${videoId}.mp4`
        },
        headers: {
          ...baseHeaders,
          Referer: 'https://www.douyin.com'
        }
      })
      return true
    }

    // 查找匹配的平台并直接调用处理函数；无平台匹配时返回 false，不吞掉消息，让其他指令继续处理
    return await this.dispatchPlatform(e)
  }

  /**
   * 处理直接发送的平台二维码图片
   * @param {any} e 事件对象
   * @returns {Promise<boolean>}
   */
  /**
   * xk解析档位：列出链接视频全部清晰度档位供选择下载。
   * 本规则优先级最高，直接进入档位模式，避免被普通平台链接规则抢走。
   */
  async tierParse(e) {
    const originalMsg = e.msg || ''
    e.msg = await Common.getReplyMessage(e)
    if (TIER_COMMAND_REG.test(originalMsg)) {
      e._xkTierCommand = true
    }
    // QQ 小程序等 JSON 卡片里的链接会被转义成 https:\/\/，先去掉反斜杠再判断
    e.msg = String(e.msg || '').replaceAll('\\', '')
    if (/bilibili\.com|b23\.tv|bili2233\.cn|\bBV[1-9a-zA-Z]{10}\b|\bav\d+\b/i.test(e.msg)) {
      return await this._bilibili(e)
    }
    if (/douyin\.com|iesdouyin\.com/i.test(e.msg)) {
      return await this._douyin(e)
    }
    await e.reply('请发送含视频链接的「xk解析档位」指令')
    return true
  }

  async imageQrCode(e) {
    const msg = await Common.getReplyMessage(e)
    if (!msg || msg === e.msg) return false
    e.msg = msg
    return await this.dispatchPlatform(e)
  }

  /**
   * 根据消息内容分发到对应平台处理器
   * @param {any} e 事件对象
   * @returns {Promise<boolean>}
   */
  async dispatchPlatform(e) {
    const config = findPlatformConfig(e.msg)
    if (!config) {
      logger.info(`[解析][DEBUG] 未匹配平台链接: msg=${JSON.stringify(String(e.msg || '')).slice(0, 180)}`)
      return false
    }
    logger.info(`[解析][DEBUG] 命中平台: ${config.handler}`)

    const shouldParse = await arbitrationShouldParse(e)
    if (!shouldParse) {
      logger.info(`[仲裁] 该消息已被其他机器人抢占，跳过 ${config.handler} 解析`)
      return true
    }

    await this[config.handler](e)
    return true
  }

  /** 私聊解析开关关闭时拦截私聊解析入口；群聊返回 false */
  _isPrivateParseBlocked(e, name) {
    if (isPrivateParseEnabled() || !isPrivateEvent(e)) return false
    logger.info(`[私聊解析] 私聊解析已关闭，跳过${name}解析`)
    return true
  }

  async runWithErrorHandler(e, businessName, fn) {
    const handler = wrapWithErrorHandler(async event => fn.call(this, event), { businessName, plugin: this })
    return await handler(e)
  }

  /**
   * 处理抖音链接解析
   * @param {any} e 事件对象
   * @returns {Promise<boolean>} 处理结果
   */
  async douyin(e) {
    if (this._isPrivateParseBlocked(e, '抖音')) return true
    if (this._shouldManualParseBlock(e, '抖音')) return true
    return await this.runWithErrorHandler(e, '抖音视频解析', this._douyin)
  }

  async _douyin(e) {
    const forceBurnDanmaku = /^#?(弹幕解析|xk弹幕解析)/.test(e.msg)
    const tierMode = Boolean(e._xkTierCommand)
    // QQ 小程序等 JSON 卡片里的链接会被转义成 https:\/\/，先去掉反斜杠再提取
    const msg = String(e.msg || '').replaceAll('\\', '')
    const urlMatch = msg.match(/https?:\/\/(?:www\.|v\.|jx\.|m\.|jingxuan\.)?(douyin\.com|iesdouyin\.com)\/[^\s]+/g)
    if (urlMatch && urlMatch[0]) {
      const result = await douyinParseQueue.run(async () => {
        const iddata = await getDouyinID(urlMatch[0])
        return await new DouYin(e, iddata, { forceBurnDanmaku, tierMode }).RESOURCES(iddata)
      })
      if (result?.type === 'douyin_user_selection') {
        const key = getSelectionKey(e)
        const selection = {
          videos: result.videos,
          expiresAt: Date.now() + result.timeoutSeconds * 1000
        }
        douyinSelections.set(key, selection)
        setTimeout(() => {
          if (douyinSelections.get(key) === selection) douyinSelections.delete(key)
        }, result.timeoutSeconds * 1000)
      }
      if (result?.type === 'douyin_tier_selection') {
        const key = getSelectionKey(e)
        const selection = {
          aweme_id: result.aweme_id,
          tiers: result.tiers,
          expiresAt: Date.now() + 120000
        }
        tierSelections.set(key, selection)
        setTimeout(() => {
          if (tierSelections.get(key) === selection) tierSelections.delete(key)
        }, 120000)
      }
      await recordParseStatistics(e, 'douyin')
    }
    return true
  }

  async selectDouyinWork(e) {
    if (this._isPrivateParseBlocked(e, '抖音主页作品选择')) return true
    const key = getSelectionKey(e)

    // xk解析档位：优先处理清晰度档位选择，按序号下载指定档
    const tierSel = tierSelections.get(key)
    if (tierSel && Date.now() <= tierSel.expiresAt && tierSel.tiers.length) {
      const index = Number((e.msg || '').replace(/^#/, ''))
      const tier = tierSel.tiers[index - 1]
      if (!Number.isFinite(index) || !tier) {
        await e.reply(`请输入 1~${tierSel.tiers.length} 之间的序号`)
        return true
      }
      tierSelections.delete(key)
      if (tierSel.platform === 'bilibili') {
        await this.runWithErrorHandler(e, 'B站指定档位下载', async event => {
          await this._bilibili(event, tier.qn, tierSel.url)
        })
        return true
      }
      const iddata = { type: 'one_work', aweme_id: tierSel.aweme_id }
      await this.runWithErrorHandler(e, '抖音指定档位下载', async event => {
        await douyinParseQueue.run(async () => {
          await new DouYin(event, iddata, { tierIndex: tier.index }).RESOURCES(iddata)
          await recordParseStatistics(event, 'douyin')
        })
      })
      return true
    }
    if (tierSel) tierSelections.delete(key)

    const selection = douyinSelections.get(key)
    if (!selection) return false
    if (Date.now() > selection.expiresAt) {
      douyinSelections.delete(key)
      await e.reply('抖音主页作品选择已超时，请重新发送主页链接')
      return true
    }

    const index = Number((e.msg || '').replace(/^#/, ''))
    const target = selection.videos[index - 1]
    if (!target) {
      await e.reply(`请输入 1~${selection.videos.length} 之间的序号`)
      return true
    }

    douyinSelections.delete(key)
    const iddata = {
      type: 'one_work',
      aweme_id: target.aweme_id
    }
    await this.runWithErrorHandler(e, '抖音主页作品选择解析', async event => {
      await douyinParseQueue.run(async () => {
        await new DouYin(event, iddata).RESOURCES(iddata)
        await recordParseStatistics(event, 'douyin')
      })
    })
    return true
  }

  /**
   * 处理B站链接解析
   * @param {any} e 事件对象
   * @returns {Promise<boolean>} 处理结果
   */
  async bilibili(e) {
    if (this._isPrivateParseBlocked(e, 'B站')) return true
    if (this._shouldManualParseBlock(e, 'B站')) return true
    return await this.runWithErrorHandler(e, 'B站视频解析', this._bilibili)
  }

  async _bilibili(e, tierQn, explicitUrl) {
    const forceBurnDanmaku = /^#?(弹幕解析|xk弹幕解析)/.test(e.msg)
    // 档位选择后 e.msg 已是序号，需用之前存下的链接，避免把序号当链接解析
    let url = (explicitUrl || e.msg || (e.message?.[0]?.data || '')).replaceAll('\\', '').trim()

    // 处理不同类型的B站链接
    if (url.includes('b23.tv')) {
      url = url.match(/(http:|https:)\/\/b23.tv\/[A-Za-z\d._?%&+\-=\/#]*/)?.[0] || url
    } else if (/bilibili\.com|bili2233\.cn/.test(url)) {
      url = url.match(/(?:https?:\/\/)?(?:www\.bilibili\.com|m\.bilibili\.com|bili2233\.cn)\/[A-Za-z\d._?%&+\-=\/#]*/)?.[0] || url
    } else if (/^BV[1-9a-zA-Z]{10}$/i.test(url) || /^av\d+$/i.test(url)) {
      url = `https://www.bilibili.com/video/${url}`
    }

    if (!url) {
      logger.warn(`未能在消息中找到有效的B站分享链接、BV号或av号: ${url}`)
      markParseFailed(e, '未找到有效的B站链接')
      return true
    }

    // 手动指定档位（xk解析档位 选择序号后）：以目标 qn 重新解析下载
    if (tierQn != null && Number.isInteger(tierQn) && tierQn > 0) {
      await bilibiliParseQueue.run(async () => {
        const id = await getBilibiliID(url)
        await new Bilibili(e, id, { forceBurnDanmaku, tierMode: false, tierQn }).RESOURCES(id)
      })
      await recordParseStatistics(e, 'bilibili')
      return true
    }

    await bilibiliParseQueue.run(async () => {
      const id = await getBilibiliID(url)
      const res = await new Bilibili(e, id, { forceBurnDanmaku, tierMode: e._xkTierCommand }).RESOURCES(id)
      if (res?.type === 'bilibili_tier_selection') {
        const key = getSelectionKey(e)
        const selection = {
          platform: 'bilibili',
          bvid: res.bvid,
          url,
          tiers: res.tiers,
          expiresAt: Date.now() + 120000
        }
        tierSelections.set(key, selection)
        setTimeout(() => {
          if (tierSelections.get(key) === selection) tierSelections.delete(key)
        }, 120000)
      }
    })
    await recordParseStatistics(e, 'bilibili')

    // 记录用户操作状态，用于选集功能
    user[e.user_id] = 'bilib'
    setTimeout(() => delete user[e.user_id], 60000)
    return true
  }

  /**
   * 处理快手链接解析
   * @param {any} e 事件对象
   * @returns {Promise<boolean>} 处理结果
   */
  async kuaishou(e) {
    if (this._isPrivateParseBlocked(e, '快手')) return true
    if (this._shouldManualParseBlock(e, '快手')) return true
    return await this.runWithErrorHandler(e, '快手视频解析', this._kuaishou)
  }

  async _kuaishou(e) {
    const url = e.msg.replaceAll('\\', '').match(/(https:\/\/v\.kuaishou\.com\/\w+|https:\/\/www\.kuaishou\.com\/f\/[a-zA-Z0-9]+)/g)
    await kuaishouParseQueue.run(async () => {
      const Iddata = await GetKuaishouID(url)
      const WorkData = await new KuaishouData(Iddata.type).GetData({ photoId: Iddata.photoId || Iddata.id })
      await new KuaiShou(e, Iddata).Action(WorkData)
    })
    await recordParseStatistics(e, 'kuaishou')
    return true
  }

  /**
   * 处理小红书链接解析
   * @param {any} e 事件对象
   * @returns {Promise<boolean>} 处理结果
   */
  async xiaohongshu(e) {
    if (this._isPrivateParseBlocked(e, '小红书')) return true
    if (this._shouldManualParseBlock(e, '小红书')) return true
    return await this.runWithErrorHandler(e, '小红书笔记解析', this._xiaohongshu)
  }

  async _xiaohongshu(e) {
    const url = e.msg.replaceAll('\\', '').match(/https?:\/\/[^\s"'<>]+/i)?.[0]
    if (!url) {
      logger.warn(`未能在消息中找到有效的小红书链接: ${e.msg}`)
      markParseFailed(e, '未找到有效的小红书链接')
      return true
    }

    await xiaohongshuParseQueue.run(async () => {
      const iddata = await getXiaohongshuID(url)
      await new Xiaohongshu(e, iddata).XiaohongshuHandler(iddata)
    })
    await recordParseStatistics(e, 'xiaohongshu')
    return true
  }

  /**
   * 处理BGM音频上传功能
   * @param {any} e 事件对象
   * @returns {Promise<boolean>} 处理结果
   */
  async uploadRecord(e) {
    try {
      // 获取音乐ID并验证
      const musicIdMatch = e.msg.match(/BGM(\d+)/)
      if (!musicIdMatch) {
        await e.reply('未找到有效的音乐ID')
        return false
      }

      // 获取音乐数据
      const data = await getDouyinData('音乐数据', Config.cookies.douyin, {
        music_id: musicIdMatch[1],
        typeMode: 'strict'
      })

      // 验证音乐数据
      if (!data?.data?.music_info) {
        await e.reply('获取音乐数据失败，可能是音乐ID错误或网络问题')
        return false
      }

      // 提取音乐信息
      const { title, play_url } = data.data.music_info
      const music_url = play_url.uri
      const musicInfo = `《${title}》\n${music_url}`

      await e.reply(`正在上传: ${musicInfo}`)
      await e.reply(await UploadRecord(e, music_url, 0, Config.douyin.sendHDrecord ? false : true))
      return true
    } catch (error) {
      logger.error('上传音乐记录时发生错误:', error)
      await e.reply('处理音乐时发生错误，请稍后重试')
      return false
    }
  }

  /**
   * 处理B站番剧选集功能
   * @param {any} e 事件对象
   * @returns {Promise<boolean>} 处理结果
   */
  async next(e) {
    if (user[e.user_id] === 'bilib') {
      const episode = e.msg.match(/第(\d+)集/)[1]
      global.BILIBILIOBJECT.Episode = episode
      await new Bilibili(e, global.BILIBILIOBJECT).RESOURCES(global.BILIBILIOBJECT, true)
    }
    return true
  }
}
