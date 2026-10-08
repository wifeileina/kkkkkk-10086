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
 * 判断事件发送者是否满足指定权限等级。
 * @param {any} event 事件对象
 * @param {string} [level] 权限等级
 * @returns {boolean}
 */
const hasPermission = (event, level) => {
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