import Config from './Config.js'

const PLATFORM_EMOJI_IDS = {
  // QQ 群聊「贴表情」区分两类：
  //   - 小表情ID（如 424/324/76）：直接用　emoji_id 传入（你的 NapCat 只认这类，424 已实测可贴出）
  //   - Unicode 十进制码点（如 128064=👀 / 128077=👍）：需带 emoji_type="2"，仅在支持该字段的实现上才可用
  qq: {
    EYES: 424,
    PROCESSING: 366,
    SUCCESS: 389,
    ERROR: 5 // 流泪/哭泣：解析失败专用标记，与成功表情 389 互斥（实测群消息回应日志中 emoji_id=5 即该表情）
  },
  discord: {
    EYES: '👀',
    PROCESSING: '⏳',
    SUCCESS: '✅',
    ERROR: '❌'
  },
  other: {
    EYES: 128064, // 👀
    PROCESSING: 366,
    SUCCESS: 389,
    ERROR: 5 // 流泪/哭泣
  }
}

const EMOJI_TYPES = ['EYES', 'PROCESSING', 'SUCCESS', 'ERROR']

const getMessageId = (event) => event?.message_id || event?.messageId || event?.message?.id

const getContact = (event) => event?.contact || event?.group || event?.friend

const getPlatform = (event) => {
  const adapter = event?.bot?.adapter
  return adapter?.platform || adapter?.name || adapter || 'other'
}

export const getEmojiId = (event, type) => {
  const platform = String(getPlatform(event)).toLowerCase()
  const group = platform.includes('discord')
    ? PLATFORM_EMOJI_IDS.discord
    : platform.includes('qq') || platform.includes('onebot') || platform.includes('lagrange') || platform.includes('napcat')
      ? PLATFORM_EMOJI_IDS.qq
      : PLATFORM_EMOJI_IDS.other
  return group[type] ?? PLATFORM_EMOJI_IDS.other[type]
}

const setByBotMethod = async (event, emojiId, isSet) => {
  const bot = event?.bot
  const messageId = getMessageId(event)
  const contact = getContact(event)

  if (typeof bot?.setMsgReaction === 'function' && contact && messageId) {
    await bot.setMsgReaction(contact, messageId, emojiId, isSet)
    return true
  }

  if (typeof bot?.sendApi === 'function' && messageId) {
    const params = {
      message_id: messageId,
      emoji_id: emojiId,
      set: isSet
    }
    // 仅 Unicode 码点(>=1000)才需要 emoji_type="2"，小表情ID(<1000，如424)按原样直传、不加 emoji_type，
    // 否则 NapCat 会报「不支持上面的emoji」（实测 424 直接传即可贴出）
    const num = Number(emojiId)
    if (!Number.isNaN(num) && num >= 1000) params.emoji_type = '2'
    await bot.sendApi('set_msg_emoji_like', params)
    return true
  }

  return false
}

export const setEmojiReaction = async (event, emojiId, isSet = true) => {
  if (!Config.app.EmojiReply) return false
  if (!event || event.isPrivate || event.is_private || !getMessageId(event)) return false

  try {
    return await setByBotMethod(event, emojiId, isSet)
  } catch (error) {
    logger.debug(`[EmojiReaction] 设置表情回应失败（已忽略）: ${error?.message || error}`)
    return false
  }
}

const isPrivate = event => Boolean(event?.isPrivate || event?.is_private || event?.message_type === 'private')

const resolveEmojiId = (event, input) => {
  if (typeof input === 'string' && EMOJI_TYPES.includes(input)) return getEmojiId(event, input)
  return input
}

const collectReactionIds = list => {
  const ids = []
  const each = item => {
    if (Array.isArray(item)) {
      item.forEach(each)
      return
    }
    if (item === null || item === undefined) return
    if (typeof item === 'object') {
      const id = item.emoji_id ?? item.emojiId ?? item.face_id ?? item.emoji
      if (id !== undefined && id !== null) ids.push(String(id))
      for (const key of ['emoji_like_list', 'reactions', 'likes', 'list', 'data']) {
        if (Array.isArray(item[key])) item[key].forEach(each)
      }
    } else {
      ids.push(String(item))
    }
  }
  each(list)
  return ids
}

export const getEmojiReactions = async (event) => {
  const bot = event?.bot
  const messageId = getMessageId(event)
  const contact = getContact(event)
  if (!bot || !messageId) return []

  if (Array.isArray(event?.current_reactions)) {
    return collectReactionIds(event.current_reactions)
  }

  if (typeof bot?.getMsgReaction === 'function' && contact) {
    try {
      const data = await bot.getMsgReaction(contact, messageId)
      return collectReactionIds(data?.reactions ?? data?.emoji_like_list ?? data)
    } catch (err) {
      logger.debug(`[EmojiReaction] 读取表情失败（已忽略）: ${err?.message || err}`)
    }
  }

  if (typeof bot?.sendApi === 'function') {
    try {
      const params = { message_id: messageId }
      if (contact?.group_id) params.group_id = contact.group_id
      const data = await bot.sendApi('get_msg_emoji_like', params)
      return collectReactionIds(data?.emoji_like_list ?? data?.reactions ?? data?.data)
    } catch (err) {
      logger.debug(`[EmojiReaction] 读取表情失败（已忽略）: ${err?.message || err}`)
    }
  }

  return []
}

const emojiTypeOf = (emojiId) => {
  const num = Number(emojiId)
  return !Number.isNaN(num) && num >= 1000 ? '2' : '1'
}

/**
 * 对齐常见解析器的 emoji 点赞逻辑：用 fetch_emoji_like 拉取指定表情的点赞用户。
 * 返回非空数组表示该表情已被（其他机器人）贴过。
 */
export const fetchEmojiLikers = async (event, emojiId) => {
  const bot = event?.bot
  const mid = getMessageId(event)
  if (!bot || !mid || typeof bot?.sendApi !== 'function') return []

  try {
    const id = String(emojiId)
    const resp = await bot.sendApi('fetch_emoji_like', {
      message_id: mid,
      emoji_id: id,
      emojiId: id,
      emojiType: emojiTypeOf(emojiId),
      count: 20
    })
    const list = resp?.emojiLikesList ?? resp?.data?.emojiLikesList ?? resp?.userList ?? []
    return Array.isArray(list) ? list : []
  } catch (err) {
    logger.debug(`[EmojiReaction] 查询表情点赞失败（已忽略）: ${err?.message || err}`)
    return []
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const collectLikerIds = (list) => {
  const ids = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const raw = item.tinyId ?? item.user_id ?? item.uid
    const id = raw !== null && typeof raw === 'object' ? (raw.tinyId ?? raw.user_id ?? raw.uid) : raw
    const num = Number(id)
    if (Number.isFinite(num)) ids.push(num)
  }
  return ids
}

/**
 * 仲裁机制（配置驱动 + 确定性协议）：返回该消息是否允许本机器人解析。
 * 表情 ID 来自 Guoba 配置（arbitrationFirstEmoji=竞争表情，arbitrationWorkingEmoji=胜出反馈），
 * 不绑定固定协议。机制为：
 *   占坑(贴竞争表情) → 等固定窗口收集所有参与者 → 以 msg_time//60 对参与者做确定性轮转排序
 *   → 按序递补贴出反馈表情，先贴出者胜出，其余全部跳过解析。
 * 确定性足以消除多台相同逻辑机器人「同时读、同时贴、同时解析」的竞态。
 */
export const arbitrationShouldParse = async (event) => {
  const app = Config.app || {}
  if (app.arbitrationEnabled === false) return true
  if (!event || isPrivate(event)) return true

  const bot = event?.bot
  const mid = getMessageId(event)
  if (!bot || !mid || typeof bot?.sendApi !== 'function') return true
  const self_id = Number(event?.self_id ?? event?.bot?.uin ?? event?.bot?.self_id)
  if (!Number.isFinite(self_id)) {
    logger.debug('[仲裁] 缺少 self_id，跳过仲裁直接解析')
    return true
  }

  const firstCfg = app.arbitrationFirstEmoji !== undefined && app.arbitrationFirstEmoji !== null && app.arbitrationFirstEmoji !== ''
    ? app.arbitrationFirstEmoji
    : 'EYES'
  const workCfg = app.arbitrationWorkingEmoji !== undefined && app.arbitrationWorkingEmoji !== null && app.arbitrationWorkingEmoji !== ''
    ? app.arbitrationWorkingEmoji
    : 'PROCESSING'
  const compete = resolveEmojiId(event, firstCfg)
  const feedback = resolveEmojiId(event, workCfg)

  const msgHasEmoji = async (emojiId) => {
    try {
      const ids = await getEmojiReactions(event)
      return ids.some(id => String(id) === String(emojiId))
    } catch { return false }
  }
  const fetchLikerIds = async (emojiId) => {
    try {
      const list = await fetchEmojiLikers(event, emojiId)
      const ids = collectLikerIds(list)
      logger.debug(`[仲裁] fetch_emoji_like(${emojiId}) 参与者=${JSON.stringify(ids)}`)
      return ids
    } catch { return [] }
  }

  // Phase 1：竞争表情已存在（已被抢占）→ 跳过解析
  if (await msgHasEmoji(compete)) {
    logger.info(`[仲裁] 竞争表情 ${compete} 已存在消息上，已被抢占，跳过解析`)
    return false
  }
  if ((await fetchLikerIds(compete)).length) {
    logger.info(`[仲裁] 竞争表情 ${compete} 已有其他机器人贴上，跳过解析`)
    return false
  }

  // Phase 2：占坑（贴竞争表情）
  const claimed = await setEmojiReaction(event, compete, true)
  if (!claimed) {
    logger.debug(`[仲裁] 占坑失败（无法贴上 ${compete}），跳过仲裁直接解析`)
    return true
  }

  // Phase 3：等待窗口，收集所有参与竞争的机器人（固定时长，保证各端参与者集合一致）
  await sleep(1000)

  // Phase 4：收集参与者（含自己）
  let users = await fetchLikerIds(compete)
  if (!users.includes(self_id)) users = [...users, self_id]
  users = [...new Set(users)].sort((a, b) => a - b)
  if (!users.length) return true
  if (users.length === 1) {
    // 仅自己参与：确立胜出（补反馈标签），允许解析
    await setEmojiReaction(event, feedback, true)
    return true
  }

  // Phase 5：确定性胜出顺序（各端计算结果一致）
  const msg_time = Number(event?.time ?? event?.timestamp ?? Math.floor(Date.now() / 1000))
  const base = Math.floor(msg_time / 60) % users.length
  const order = users.map((_, i) => users[(base + i) % users.length])

  // Phase 6：确定性递补确认，按序每人有轮次补贴反馈表情，先贴出者胜出
  for (const candidate of order) {
    if (candidate === self_id) {
      try { await setEmojiReaction(event, feedback, true) } catch { /* 忽略 */ }
    }
    await sleep(700)
    if ((await fetchLikerIds(feedback)).length || await msgHasEmoji(feedback)) {
      const win = candidate === self_id
      logger.info(`[仲裁] 仲裁结果：${win ? '本机胜出，执行解析' : `他人(${candidate})胜出，本机跳过解析`}`)
      return win
    }
  }
  logger.info('[仲裁] 仲裁流程未确认胜出者，本机跳过解析')
  return false
}

/**
 * 解析结果标记：供各平台解析器在返回前打标，由 wrapWithErrorHandler 在流程结束时读取，
 * 决定把 PROCESSING 换成 SUCCESS(成功) 还是 ERROR(哭泣，失败)。
 *   markParseFailed  —— 解析失败/出错（作品不存在、接口拿不到数据、不支持的类型等）：不贴成功表情，改贴哭泣
 *   markParseLimited —— 规则限制导致的停止解析（体积超限、上传大小限制等）：不算失败，保持原成功表情
 * 注意两者互斥，后调用者生效（避免先标记失败又被规则限制覆盖）。
 */
export const markParseFailed = (event, reason) => {
  if (!event) return
  event._xkParseFailed = true
  event._xkParseLimited = false
  if (reason) event._xkParseFailedReason = reason
}

export const markParseLimited = (event, reason) => {
  if (!event) return
  event._xkParseLimited = true
  event._xkParseFailed = false
  if (reason) event._xkParseLimitedReason = reason
}

export const isParseFailed = event => Boolean(event?._xkParseFailed) && !event?._xkParseLimited

export class EmojiReactionManager {
  constructor (event) {
    this.event = event
    this.emojiIds = new Set()
  }

  getPlatformEmojiId (type) {
    return getEmojiId(this.event, type)
  }

  normalizeEmojiId (emojiId) {
    return typeof emojiId === 'string' && EMOJI_TYPES.includes(emojiId)
      ? this.getPlatformEmojiId(emojiId)
      : emojiId
  }

  async add (emojiId) {
    const actualEmojiId = this.normalizeEmojiId(emojiId)
    const success = await setEmojiReaction(this.event, actualEmojiId, true)
    if (success) this.emojiIds.add(actualEmojiId)
    return success
  }

  async remove (emojiId) {
    const actualEmojiId = this.normalizeEmojiId(emojiId)
    const success = await setEmojiReaction(this.event, actualEmojiId, false)
    if (success) this.emojiIds.delete(actualEmojiId)
    return success
  }

  async replace (oldEmojiId, newEmojiId, delayMs = 2000) {
    const addSuccess = await this.add(newEmojiId)
    await new Promise(resolve => setTimeout(resolve, delayMs))
    await this.remove(oldEmojiId)
    return addSuccess
  }

  async clearAll () {
    let count = 0
    for (const emojiId of this.emojiIds) {
      if (await setEmojiReaction(this.event, emojiId, false)) count++
    }
    this.emojiIds.clear()
    return count
  }

  has (emojiId) {
    return this.emojiIds.has(this.normalizeEmojiId(emojiId))
  }

  count () {
    return this.emojiIds.size
  }
}
