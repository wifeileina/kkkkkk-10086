import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import Config from './Config.js'
import Common from './Common.js'
import { Networks } from './Networks.js'

// 文件名非法字符（Windows/NTFS 与常见机器人框架均不接受）
const ILLEGAL_RE = /[\\/:*?"<>|\r\n\t]+/g
const MAX_NAME_LEN = 200
// 描述过长时保留首尾、中间省略；标签不参与截断
const MAX_DESC_LEN = 90

/** 归一化发送模式：兼容旧的布尔配置；all=全部文件、image=仅图文、normal=普通 */
export const normalizeFileSendMode = (value) => {
  if (value === true) return 'all'
  if (value === 'all' || value === 'image') return value
  return 'normal'
}

// 单次解析的发送模式覆盖（并发解析互不影响）
const fileSendModeStore = new AsyncLocalStorage()

/** 当前发送模式 */
export const getFileSendMode = () => {
  // 「文件解析」类指令在本次解析的异步上下文中临时覆盖全局设置
  const forced = fileSendModeStore.getStore()
  return normalizeFileSendMode(forced ?? Config.advanced?.fileSendMode)
}

/** 本次解析强制指定发送模式（如「文件解析」指令 -> all） */
export const runWithFileSendMode = (mode, fn) => fileSendModeStore.run(normalizeFileSendMode(mode), fn)

/** 是否「全部文件」模式（视频/BGM 也发文件） */
export const isFileSendMode = () => getFileSendMode() === 'all'

/** 是否图集/实况发文件（全部文件 或 仅图文） */
export const isImageFileSendMode = () => {
  const mode = getFileSendMode()
  return mode === 'all' || mode === 'image'
}

/** 是否把多个媒体打包成一个压缩包发送 */
export const isFileArchiveEnabled = () => Config.advanced?.fileSendArchive !== false

/** 触发压缩包的媒体数量下限：媒体数超过该值时才打包，默认 3 */
export const getFileArchiveMinCount = () => {
  const value = Number(Config.advanced?.fileSendArchiveMinCount)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3
}

/** 当前媒体集合是否会被打包（按组计数；需在追加额外条目前调用） */
export const shouldArchiveMedia = (items = []) => {
  const valid = items.filter((item) => item?.source && item?.baseName)
  if (!valid.length) return false
  // 按「组」计数：实况的 jpg+mp4 同名同组，只算一条
  const groupCount = new Set(valid.map((item) => String(item.baseName))).size
  return isFileArchiveEnabled() && groupCount > getFileArchiveMinCount()
}

// 代理区码点（emoji 等非 BMP 字符）：协议端处理文件名时可能序列化出非法 UTF-8，统一剔除
const ASTRAL_RE = /[\uD800-\uDFFF]/g

const clean = (value) => String(value ?? '').replace(ASTRAL_RE, '').replace(ILLEGAL_RE, ' ').replace(/\s+/g, ' ').trim()

// 平台缺失简介时会用「抖音视频 / 快手作品」这类占位词，作为文件名没有信息量
const PLACEHOLDER_DESC_RE = /^(?:抖音|快手|小红书|哔哩哔哩|B站)?(?:视频|作品|笔记|图文)(?:_[^\s]+)?$/

const pad2 = (value) => String(value).padStart(2, '0')

/** 当日日期：YYYY-MM-DD */
const todayText = () => {
  const date = new Date()
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 中间省略：保留首尾，超出部分用 ... 表示 */
export const middleEllipsis = (text, max = MAX_DESC_LEN) => {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const keep = Math.max(1, max - 3)
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${s.slice(0, head)}...${s.slice(-tail)}`
}

/**
 * 构建媒体文件名（不含扩展名）：@作者-描述 #标签 #标签
 * 多组时追加序号：第 1 组 _0，之后 _01、_02…；仅一组不追加。
 * @param {Object} options
 * @param {string} [options.author] 作者
 * @param {string} [options.description] 标题/描述
 * @param {string[]} [options.tags] 标签（不带 #）
 * @param {number} [options.index] 组序号（0 起）
 * @param {number} [options.total] 组总数
 * @param {'video'|'media'} [options.style] 命名风格：video=「@作者-简介」，media=「@作者 简介」
 * @returns {string}
 */
export const buildMediaName = ({ author, description, tags = [], index, total, style = 'video' } = {}) => {
  const authorText = clean(author)
  const tagText = (Array.isArray(tags) ? tags : [])
    .map((tag) => clean(String(tag ?? '').replace(/^#+/, '')))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(' ')

  const rawDesc = clean(description)
  // 没有真实简介（或只有「抖音视频」这类占位词）时用日期替代
  const validDesc = PLACEHOLDER_DESC_RE.test(rawDesc) ? '' : rawDesc

  let indexSuffix = ''
  if (Number.isFinite(index) && Number.isFinite(total) && total > 1) {
    indexSuffix = index === 0 ? '_0' : `_${String(index).padStart(2, '0')}`
  } else if (!validDesc) {
    // 无简介时以日期标识，同样带上排序
    indexSuffix = '_0'
  }

  // 先为「标签 + 序号」预留长度，保证标签不被截断；只对描述做中间省略
  const reserved = (tagText ? tagText.length + 1 : 0) + indexSuffix.length + (authorText ? authorText.length + 2 : 0)
  const descBudget = Math.max(12, MAX_NAME_LEN - reserved)
  const descText = middleEllipsis(validDesc || todayText(), descBudget)

  const name = [authorText ? `@${authorText}` : '', descText].filter(Boolean).join(style === 'media' ? ' ' : '-')
  const withTags = tagText ? `${name} ${tagText}` : name
  return `${withTags.slice(0, MAX_NAME_LEN - indexSuffix.length)}${indexSuffix}`
}

const extOf = (source, fallback = '.jpg') => {
  try {
    const raw = String(source || '')
    if (raw.startsWith('file://')) return path.extname(raw.slice(7)) || fallback
    if (/^https?:\/\//i.test(raw)) return path.extname(new URL(raw).pathname) || fallback
    return path.extname(raw) || fallback
  } catch {
    return fallback
  }
}

const localizeSource = async (source, ext, headers) => {
  if (/^https?:\/\//i.test(source)) {
    const dir = path.join(Common.tempDri.images)
    await Common.mkdir(dir)
    const filepath = path.join(dir, `filesend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`)
    await new Networks({ url: source, filepath, headers: headers || {}, timeout: Config.request?.timeout || 30000 }).downloadStream(() => {})
    return { filepath, cleanup: true }
  }
  if (source.startsWith('base64://')) {
    const dir = path.join(Common.tempDri.images)
    await Common.mkdir(dir)
    const filepath = path.join(dir, `filesend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`)
    await fs.promises.writeFile(filepath, Buffer.from(source.slice(9), 'base64'))
    return { filepath, cleanup: true }
  }
  if (source.startsWith('file://')) return { filepath: source.slice(7), cleanup: false }
  return { filepath: source, cleanup: false }
}

/**
 * 把本地文件转成框架的 HTTP 文件地址（NapCat 等跨进程/跨系统适配器无法读取 Bot 侧本地路径）。
 * 转换失败时回退为 file:// 地址。
 * @param {*} e 事件对象
 * @param {string} filepath 本地路径
 * @param {string} [fileName] 展示文件名
 * @returns {Promise<string>}
 */
export const toFileUrl = async (e, filepath, fileName) => {
  // 全局 Bot 是框架的 Yunzai 实例（自带 fileToUrl 文件服务）；e.bot 是适配器侧的轻量对象，没有该方法
  try {
    const url = await globalThis.Bot?.fileToUrl?.(filepath, fileName ? { name: fileName } : undefined)
    if (url) return String(url)
  } catch (error) {
    logger.debug(`[FileSend] 本地文件转 HTTP 地址失败: ${error?.message || error}`)
  }
  return /^file:\/\//i.test(filepath) ? filepath : `file://${filepath}`
}

const hasError = (result) => {
  if (!result) return false
  if (Array.isArray(result)) return result.some(hasError)
  return Boolean(result.error)
}

// NapCat 的 upload_group_file 在接口返回后仍会异步上传（聊天里先是「文件发送中」），
// 立刻删除临时文件会让上传中断、文件名/后缀丢失，因此延迟清理。
const CLEANUP_DELAY = 10 * 60 * 1000
const scheduleCleanup = (filepath) => {
  if (!filepath) return
  setTimeout(() => { Common.removeFile(filepath, true).catch(() => {}) }, CLEANUP_DELAY)
}

/** 发送一个 file 段；主动消息走指定机器人/群，其余走当前事件 */
const sendFileSegment = async (e, fileField, fileName, active, activeOption) => {
  const fileSegment = segment.file(fileField, fileName)
  if (active && activeOption) {
    const target = activeOption?.uin
      ? Bot?.[activeOption.uin]?.pickGroup(activeOption.group_id)
      : e.isGroup ? e.group : e.friend
    return await target?.sendMsg(fileSegment)
  }
  return await e.reply(fileSegment)
}

/**
 * 发送本地文件：转成框架 HTTP 文件服务地址后发送。
 * @param {*} e 事件/机器人对象
 * @param {Object} options
 * @param {string} options.filepath 本地文件路径
 * @param {string} options.fileName 展示文件名
 * @param {boolean} [options.active] 是否为主动消息
 * @param {*} [options.activeOption] 主动消息目标
 * @returns {Promise<*>}
 */
export const sendLocalFile = async (e, { filepath, fileName, active, activeOption } = {}) => {
  return await sendFileSegment(e, await toFileUrl(e, filepath, fileName), fileName, active, activeOption)
}

/** 归一化扩展名：显式带的优先，否则按源地址推断 */
const resolveExt = (source, ext) => {
  if (String(ext || '').startsWith('.')) return ext
  if (ext) return `.${ext}`
  return extOf(source)
}

/**
 * 以「文件」形式发送单个媒体。
 * @param {*} e 事件/机器人对象
 * @param {Object} options
 * @param {string} options.source 本地路径 / file:// / base64:// / http(s) 地址
 * @param {string} options.baseName 文件名（不含扩展名）
 * @param {string} [options.ext] 扩展名（缺省按源地址推断）
 * @param {Object} [options.headers] 下载远程资源时的请求头
 * @param {boolean} [options.active] 是否为主动消息
 * @param {*} [options.activeOption] 主动消息目标
 * @returns {Promise<*>}
 */
export const sendMediaAsFile = async (e, { source, baseName, ext, headers, active, activeOption } = {}) => {
  if (!source || !baseName) return false
  const resolvedExt = resolveExt(source, ext)
  const fileName = `${baseName}${resolvedExt}`
  const { filepath, cleanup } = await localizeSource(String(source), resolvedExt, headers)
  try {
    return await sendLocalFile(e, { filepath, fileName, active, activeOption })
  } finally {
    if (cleanup) scheduleCleanup(filepath)
  }
}

// ── 极简 ZIP（store 模式）：媒体本身已压缩，再 deflate 意义不大，store 更快且无需第三方依赖 ──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const buildZip = (entries) => {
  const date = new Date()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()

  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, name, data)
    central.push({ name, crc, size: data.length, offset })
    offset += local.length + name.length + data.length
  }

  const centralStart = offset
  for (const item of central) {
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(dosTime, 12)
    record.writeUInt16LE(dosDate, 14)
    record.writeUInt32LE(item.crc, 16)
    record.writeUInt32LE(item.size, 20)
    record.writeUInt32LE(item.size, 24)
    record.writeUInt16LE(item.name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(item.offset, 42)

    chunks.push(record, item.name)
    offset += record.length + item.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  chunks.push(end)

  return Buffer.concat(chunks)
}

/** 压缩包名：去掉 buildMediaName 追加的组序号（_0 / _01 / _02…）
 *  群文件名过长时协议端可能截断甚至丢掉后缀，这里限制在安全长度内并保留 .zip */
const MAX_ARCHIVE_BASE = 96
const buildArchiveName = (items) => {
  const first = String(items[0]?.baseName || '解析结果').trim()
  const stripped = first.replace(/\s*_\d{1,2}$/, '').trim()
  return `${middleEllipsis(stripped || first, MAX_ARCHIVE_BASE)}.zip`
}

const uniqueEntryName = (used, name) => {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let index = 2
  while (used.has(`${base}(${index})${ext}`)) index++
  const next = `${base}(${index})${ext}`
  used.add(next)
  return next
}

/**
 * 把多个媒体打包成一个 zip 发送（全部本地化后再打包，可在小体积下避免逐条上传刷屏）。
 * @param {*} e 事件对象
 * @param {Array<{source: string, baseName: string, ext?: string, headers?: object}>} items
 * @param {Object} [options]
 * @param {boolean} [options.active] 是否为主动消息
 * @param {*} [options.activeOption] 主动消息目标
 * @returns {Promise<*>}
 */
export const sendMediaArchive = async (e, items = [], { active, activeOption } = {}) => {
  const used = new Set()
  const localized = []
  const entries = []
  try {
    for (const item of items) {
      const resolvedExt = resolveExt(item.source, item.ext)
      const { filepath, cleanup } = await localizeSource(String(item.source), resolvedExt, item.headers)
      localized.push({ filepath, cleanup })
      entries.push({
        name: uniqueEntryName(used, `${item.baseName}${resolvedExt}`),
        data: await fs.promises.readFile(filepath)
      })
    }

    const dir = path.join(Common.tempDri.images)
    await Common.mkdir(dir)
    const zipPath = path.join(dir, `filesend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.zip`)
    await fs.promises.writeFile(zipPath, buildZip(entries))
    try {
      return await sendLocalFile(e, { filepath: zipPath, fileName: buildArchiveName(items), active, activeOption })
    } finally {
      // 压缩包要等 NapCat 后台真正传完才能删
      scheduleCleanup(zipPath)
    }
  } finally {
    for (const item of localized) if (item.cleanup) Common.removeFile(item.filepath, true).catch(() => {})
  }
}

/**
 * 批量发送媒体文件：开启「压缩包发送」且媒体数超过阈值时打包成一个 zip，否则逐个发送。
 * @param {*} e 事件对象
 * @param {Array<{source: string, baseName: string, ext?: string, headers?: object}>} items
 */
export const sendMediaFiles = async (e, items = []) => {
  const valid = items.filter((item) => item?.source && item?.baseName)
  if (!valid.length) return

  if (shouldArchiveMedia(valid)) {
    let result
    try {
      result = await sendMediaArchive(e, valid)
    } catch (error) {
      logger.error(`[FileSend] 压缩包打包失败，回退逐个发送: ${error?.message || error}`)
    }
    if (result && !hasError(result)) return result
    if (result) logger.error('[FileSend] 压缩包发送失败，回退逐个发送')
  }

  for (const item of valid) await sendMediaAsFile(e, item)
}
