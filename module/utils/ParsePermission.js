import Config from './Config.js'
import { getCachedData, setCachedData } from './ResourceCache.js'

/**
 * 是否为显式指令解析：由用户主动触发解析指令（xk解析 / xk档位 / 档位序号选择等）。
 * 事件标记由 apps/tools.js 写入（_xkCommandParse / _xkTierCommand）。
 * @param {any} event 事件对象
 * @returns {boolean}
 */
export const isCommandParse = (event) => Boolean(event?._xkCommandParse || event?._xkTierCommand)

/**
 * 信息图防重复窗口：体积超限后用户用指令继续解析（如回复「xk解析」）时，
 * 同一会话内的同一作品在 120s 内不再重复发送信息图（各平台共用）。
 */
export const INFO_GRAPHIC_DEDUP_WINDOW = 120 * 1000
const infoGraphicCacheKey = (event, id) => `info-sent:${event?.group_id ?? event?.user_id ?? 'na'}:${id}`

/** 同一会话内的同一作品是否在防重复窗口内已发送过信息图 */
export const isInfoGraphicRecentlySent = (event, id) => {
  if (!id) return false
  const last = getCachedData(infoGraphicCacheKey(event, id))
  return Boolean(last) && Date.now() - last < INFO_GRAPHIC_DEDUP_WINDOW
}

/** 记录信息图发送时间，用于后续指令解析去重 */
export const markInfoGraphicSent = (event, id) => {
  if (id) setCachedData(infoGraphicCacheKey(event, id), Date.now())
}

/** 指令继续解析且窗口内已发过信息图时，应跳过本次信息图发送 */
export const shouldSkipInfoGraphic = (event, id) => isCommandParse(event) && isInfoGraphicRecentlySent(event, id)

const PERMISSION_LABELS = {
  all: '所有人',
  admin: '管理员',
  master: '主人',
  'group.owner': '群主',
  'group.admin': '群管理员'
}

/**
 * 当前配置的超限解析权限等级，与推送权限选项一致。
 * @returns {'all'|'admin'|'master'|'group.owner'|'group.admin'}
 */
export const overLimitPermissionLevel = () => Config.app?.overLimitCommandParsePermission || 'master'

/**
 * 当前配置的超限解析权限等级的中文名。
 * @returns {string}
 */
export const overLimitPermissionLabel = () => PERMISSION_LABELS[overLimitPermissionLevel()] || '主人'

/**
 * 权限等级对应的中文名。
 * @param {string} [level] 权限等级
 * @returns {string}
 */
export const permissionLabel = (level) => PERMISSION_LABELS[level] || '主人'

/**
 * 判断事件发送者是否满足指定权限等级。
 * @param {any} event 事件对象
 * @param {string} [level] 权限等级
 * @returns {boolean}
 */
export const hasPermission = (event, level) => {
  if (!level || level === 'all') return true
  if (event?.isMaster) return true
  if (level === 'master') return false
  if (!event?.isGroup) return false
  const isOwner = Boolean(event.member?.is_owner)
  const isAdmin = isOwner || Boolean(event.member?.is_admin)
  if (level === 'owner' || level === 'group.owner') return isOwner
  if (level === 'admin' || level === 'group.admin') return isAdmin
  return true
}

/**
 * 是否具备超限指令解析资格：全局开关开启且发送者权限达标。
 * @param {any} event 事件对象
 * @returns {boolean}
 */
export const canUseOverLimitParse = (event) =>
  Config.app?.overLimitCommandParse !== false &&
  hasPermission(event, overLimitPermissionLevel())

/**
 * 体积超限时是否允许强制解析下载：具备资格且本次为显式指令解析（全平台统一生效）。
 * @param {any} event 事件对象
 * @returns {boolean}
 */
export const canBypassSizeLimit = (event) =>
  isCommandParse(event) && canUseOverLimitParse(event)

/**
 * 超限提示档位，仅由「超限指令解析」开关与权限配置决定：
 * - all：权限为「所有人」，只提示指令
 * - plain：开关关闭或权限为「主人」，只提示已停止下载，不提示指令
 * - command：权限为管理员 / 群主 / 群管理员，提示指令并附「权限：xxx」
 * @returns {'all'|'plain'|'command'}
 */
export const overLimitHintMode = () => {
  if (Config.app?.overLimitCommandParse === false) return 'plain'
  const level = overLimitPermissionLevel()
  if (level === 'all') return 'all'
  if (level === 'master') return 'plain'
  return 'command'
}

/**
 * 聊天消息用的超限提示尾注，与信息图提示档位保持一致。
 * @returns {string}
 */
export const overLimitTipSuffix = () => {
  switch (overLimitHintMode()) {
    case 'all':
      return '\n继续下载请引用回复：xk解析'
    case 'plain':
      return ''
    default:
      return `\n继续下载请引用回复：xk解析 权限：${overLimitPermissionLabel()}`
  }
}

// ============================================================
// 档位列表的超限限制（xk解析档位）
// 超出体积上限的档位对无权限者不予下载，但按「超限档位显示」配置决定展示方式。
// ============================================================

/** 档位回复的有效期（秒），超时后回复序号不再生效 */
export const TIER_SELECTION_TIMEOUT_SECONDS = 30

/** 超限档位权限等级：谁能选择体积超过上限的档位 */
export const tierOverLimitPermissionLevel = () => Config.advanced?.tierOverLimitPermission || 'master'

/** 超限档位权限等级的中文名 */
export const tierOverLimitPermissionLabel = () => permissionLabel(tierOverLimitPermissionLevel())

/**
 * 超限档位显示方式：
 * - open：开放，全部档位可选（不做限制）
 * - limit：限制，超限档位单独列出但不可选
 * - hide：隐藏，超限档位折叠为「存在更高档位」
 * @returns {'open'|'limit'|'hide'}
 */
export const tierOverLimitDisplayMode = () => {
  const mode = Config.advanced?.tierOverLimitDisplay
  return ['open', 'limit', 'hide'].includes(mode) ? mode : 'limit'
}

/** 是否可自由选择超限档位（开放模式或权限达标） */
export const canSelectOverLimitTier = (event) =>
  tierOverLimitDisplayMode() === 'open' || hasPermission(event, tierOverLimitPermissionLevel())

/**
 * 平台体积上限（字节）；返回 0 表示不限制。
 * @param {'douyin'|'bilibili'|'kuaishou'|'xiaohongshu'} platform
 * @returns {number}
 */
export const getTierSizeLimitBytes = (platform) => {
  const conf = Config?.[platform] || {}
  if (conf.limitVideoSize === false) return 0
  const mb = Number(conf.maxAutoVideoSize)
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0
}

/**
 * 生成档位列表文案，并按权限拆分可选档位。
 * @param {any} event 事件对象
 * @param {Array<{ line: string, sizeBytes?: number }>} tiers 档位列表（每项含已排版好的单行文本）
 * @param {number} limitBytes 体积上限（字节），0 表示不限制
 * @returns {{ text: string, selectable: any[] }}
 */
export const buildTierMessage = (event, tiers = [], limitBytes = 0) => {
  const limit = Number(limitBytes) || 0
  // 体积信息齐全时按体积从大到小排列，超限档位自然排在前面；有缺失时保持平台原顺序。
  // 同时带分辨率与体积的档位（抖音/小红书）优先按分辨率从大到小排列，避免高码率低分辨率档
  // （如 720P 10.9MB）插到 2K 前面造成困惑。
  const hasResolution = tiers.length > 0 && tiers.every((tier) => Number(tier?.width) > 0 && Number(tier?.height) > 0)
  const hasSize = tiers.length > 0 && tiers.every((tier) => Number(tier?.sizeBytes) > 0)
  const ordered = hasResolution
    ? [...tiers].sort((a, b) => (Number(b.width) * Number(b.height)) - (Number(a.width) * Number(a.height))
      || Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0))
    : hasSize
      ? [...tiers].sort((a, b) => Number(b.sizeBytes) - Number(a.sizeBytes))
      : tiers
  const blocked = []
  const allowed = []
  for (const tier of ordered) {
    const size = Number(tier?.sizeBytes) || 0
    if (limit > 0 && size > limit) blocked.push(tier)
    else allowed.push(tier)
  }

  // 无超限档位、有权限或开放模式：保持单列表，全部可选
  if (!blocked.length || canSelectOverLimitTier(event)) {
    const lines = ordered.map((tier, index) => `${index + 1}. ${tier.line}`)
    return {
      text: `该视频支持以下清晰度档位，回复序号即可选择下载（${TIER_SELECTION_TIMEOUT_SECONDS} 秒内有效）：\n${lines.join('\n')}`,
      selectable: ordered
    }
  }

  const permLabel = tierOverLimitPermissionLabel()
  const sections = []
  if (tierOverLimitDisplayMode() === 'hide') {
    sections.push(`【存在更高档位】权限：${permLabel}`)
  } else {
    sections.push(`【不可选择】权限：${permLabel}`)
    sections.push(...blocked.map((tier, index) => `${index + 1}. ${tier.line}`))
  }
  sections.push('【可选档位】')
  sections.push(...(allowed.length
    ? allowed.map((tier, index) => `${index + 1}. ${tier.line}`)
    : ['当前权限下没有可选择的档位']))
  if (allowed.length) sections.push(`回复序号即可选择下载（${TIER_SELECTION_TIMEOUT_SECONDS} 秒内有效）`)

  return { text: sections.join('\n'), selectable: allowed }
}