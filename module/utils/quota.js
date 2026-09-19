import fs from 'node:fs'
import Version from './Version.js'
import Config from './Config.js'

const quotaFile = `${Version.pluginPath}/data/quota.json`
const BYTES_PER_MB = 1024 * 1024

const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(quotaFile, 'utf8')) || {}
  } catch {
    return {}
  }
}

const save = data => {
  try {
    fs.mkdirSync(`${Version.pluginPath}/data`, { recursive: true })
    fs.writeFileSync(quotaFile, JSON.stringify(data))
  } catch (error) {
    console.error('[配额] 写入配额记录失败:', error)
  }
}

const entry = () => {
  const data = load()
  const key = todayKey()
  if (!data[key]) data[key] = { download: 0, upload: 0 }
  data[key].download = Number(data[key].download) || 0
  data[key].upload = Number(data[key].upload) || 0
  return { data, key, record: data[key] }
}

/** 今日某类已用流量，单位：字节 */
export const getUsedBytes = kind => {
  try {
    return entry().record[kind] || 0
  } catch {
    return 0
  }
}

/** 累加某类流量并返回累加后值，单位：字节 */
export const addUsedBytes = (kind, bytes) => {
  const { data, key, record } = entry()
  record[kind] = (record[kind] || 0) + (Number(bytes) || 0)
  // 跨天后清掉旧日期记录，避免配额文件无限膨胀
  for (const k of Object.keys(data)) if (k !== key) delete data[k]
  save(data)
  return record[kind]
}

/** 重置今日配额统计，返回被清除的用量（字节） */
export const resetQuota = () => {
  const { data, key, record } = entry()
  const cleared = { download: record.download || 0, upload: record.upload || 0 }
  record.download = 0
  record.upload = 0
  save(data)
  return cleared
}

const quotaConfig = () => {
  const q = Config.upload?.quota || {}
  return {
    enable: !!q.enable,
    downloadLimit: Number(q.downloadLimit) || 0,
    uploadLimit: Number(q.uploadLimit) || 0,
    forcePermission: q.forcePermission || 'master',
    // 主人不计入配额：开启后主人(机器人主人)的下载/上传不参与配额统计，也不受配额拦截
    masterExempt: !!q.masterExempt
  }
}

// 主人恒不因配额被拦截：主人超限也可正常解析（拦截豁免与统计与否无关）
export const isMaster = e => !!e?.isMaster

// 主人是否豁免配额统计：开关开启 且 发送者为主人。仅影响是否计入统计，不影响拦截
export const isMasterExempt = e => {
  const c = quotaConfig()
  return c.masterExempt && isMaster(e)
}

// 判断发送者是否满足指定权限（取值：all / master / admin / group.owner / group.admin）
export const hasPermission = (e, permission) => {
  if (!permission || permission === 'all') return true
  if (permission === 'master') return !!e?.isMaster
  const senderRole = e?.sender?.role || e?.sender?.group_role || ''
  const isGroupAdmin = e?.isGroup && ['owner', 'admin'].includes(senderRole)
  if (permission === 'admin') return !!e?.isMaster || !!e?.isAdmin || !!isGroupAdmin
  if (permission === 'group.owner') return e?.isGroup && senderRole === 'owner'
  if (permission === 'group.admin') return e?.isGroup && ['owner', 'admin'].includes(senderRole)
  return false
}

// 配额超限后，发送者是否可强制解析（满足配置的强制解析权限）
export const canForceParse = e => {
  const c = quotaConfig()
  if (!c.enable) return false
  return hasPermission(e, c.forcePermission)
}

// 是否应在信息图展示"继续下载指令"提示：
// 至少一个限额已开启（下载或上传 limit>0）、配额本次确实超限、强制权限非 master、且当前发送者无强制权限
const shouldShowForceHint = (e, currentBytes) => {
  const c = quotaConfig()
  if (!c.enable || c.forcePermission === 'master') return false
  if (c.downloadLimit <= 0 && c.uploadLimit <= 0) return false
  if (hasPermission(e, c.forcePermission)) return false
  // 配额未超限时无需提示强制解析；仅在下载或上传任一方向本此会超限被拦时才展示
  return isDownloadBlocked(currentBytes) || isUploadBlocked(currentBytes)
}

/** 判断本次下载是否会导致当日下载配额超限 */
export const isDownloadBlocked = bytes => {
  const c = quotaConfig()
  if (!c.enable || c.downloadLimit <= 0) return false
  return getUsedBytes('download') + (Number(bytes) || 0) > c.downloadLimit * BYTES_PER_MB
}

/** 判断本次上传是否会导致当日上传配额超限 */
export const isUploadBlocked = bytes => {
  const c = quotaConfig()
  if (!c.enable || c.uploadLimit <= 0) return false
  return getUsedBytes('upload') + (Number(bytes) || 0) > c.uploadLimit * BYTES_PER_MB
}

/**
 * 生成信息图配额提示的展示数据
 * @param {*} e 发送者事件
 * @param {number} [currentBytes] 本次视频预计消耗字节（下载/上传均以此预估，叠加到当日已用上展示）。无则仅显示历史用量
 * @returns {{enabled:boolean, text:string, showForceHint:boolean, forcePermissionLabel:string}}
 */
export const getQuotaInfo = (e, currentBytes = 0) => {
  const c = quotaConfig()
  const cur = Math.max(0, Number(currentBytes) || 0)
  const mb = b => Number((b / BYTES_PER_MB).toFixed(1))
  const dlLimitBytes = c.downloadLimit > 0 ? c.downloadLimit * BYTES_PER_MB : 0
  const ulLimitBytes = c.uploadLimit > 0 ? c.uploadLimit * BYTES_PER_MB : 0
  const usedDl = getUsedBytes('download')
  const usedUl = getUsedBytes('upload')
  // 本次会话在对应方向是否会被拦截：被拦截则实际不会消耗该方向流量，因此不把本次视频大小预估进该方向，
  // 避免「上传/下载被拦截却仍显示在增长」的假象（如上传超限被挡住后，上传不再虚增本次视频大小）
  const dlBlocked = dlLimitBytes > 0 && usedDl + cur > dlLimitBytes
  const ulBlocked = ulLimitBytes > 0 && usedUl + cur > ulLimitBytes
  // 展示用的用量 = 当日已用 + 本次预估值；仅在被拦截方向保留当日已用量，其余方向叠加本次预估以预演解析后配额
  const dlShown = usedDl + (dlBlocked ? 0 : cur)
  const ulShown = usedUl + (ulBlocked ? 0 : cur)
  // 达到上限时给「已使用数字」标红：被拦截方向按已达上限处理；未拦截方向按叠加本次后的结果判断
  const dlOver = dlLimitBytes > 0 && (dlBlocked || dlShown >= dlLimitBytes)
  const ulOver = ulLimitBytes > 0 && (ulBlocked || ulShown >= ulLimitBytes)
  // 有相对方向的限额时给出红字标记；未开启限额则该方向不显示用量
  const fmtUsed = (shown, over) => (over ? `<span class="quota-used-over">${mb(shown)}</span>` : String(mb(shown)))
  const parts = []
  // 开启了下载限额：显示 "下载 已用/限额MB"；未开启则显示 "下载 已用MB"（仅用量，无上限）
  if (c.downloadLimit > 0) parts.push(`下载 ${fmtUsed(dlShown, dlOver)}/${c.downloadLimit}MB`)
  else parts.push(`下载 ${mb(dlShown)}MB`)
  if (c.uploadLimit > 0) parts.push(`上传 ${fmtUsed(ulShown, ulOver)}/${c.uploadLimit}MB`)
  else parts.push(`上传 ${mb(ulShown)}MB`)
  const permissionLabel = {
    master: '主人',
    admin: '管理员',
    'group.owner': '群主',
    'group.admin': '群管理员',
    all: '所有人'
  }[c.forcePermission] || c.forcePermission
  return {
    enabled: true,
    // 达到配额上限时，已使用数字会被 .quota-used-over 标红；模板需用 {{@}} 不转义输出
    text: `流量统计：${parts.join(' · ')}`,
    // 强制解析提示：仅配额启用且本此确实超限、强制权限非 master、当前发送者无强制权限时展示
    showForceHint: shouldShowForceHint(e, cur),
    forcePermissionLabel: permissionLabel
  }
}