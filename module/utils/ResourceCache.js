import fs from 'node:fs'

// ============================================================
// 同一视频/资源复用缓存
// 首次解析下载后，缓存其视频文件路径 10 分钟。期间其他群转发同一视频时直接复用该文件发送，
// 避免对同一资源重复发起平台 API 解析请求（限流来源）与重复下载大文件。
// 缓存 key 由各平台调用方传入（如 aweme_id / 快手 photoId / B站 bvid）。
// ============================================================

const CACHE_TTL = 10 * 60 * 1000

/** @type {Map<string, { filepath:string, totalBytes:number, savedAt:number }>} */
const entries = new Map()
/** @type {Map<string, Promise<any>>} 同一 key 正在进行的下载，用于并发单飞去重 */
const inflight = new Map()

/** @type {Map<string, { data:any, savedAt:number }>} 平台解析结果缓存（VideoData/CommentsData 等） */
const dataEntries = new Map()
/** @type {Map<string, Promise<any>>} 同一 key 正在进行的解析，用于并发单飞去重 */
const dataInflight = new Map()
/** 解析结果缓存 TTL：5 分钟，足够覆盖多群连续转发同一链接 */
const DATA_TTL = 5 * 60 * 1000

const isEntryFresh = (entry) => {
  if (!entry || !entry.filepath) return false
  if (Date.now() - entry.savedAt > CACHE_TTL) return false
  try {
    return fs.existsSync(entry.filepath)
  } catch {
    return false
  }
}

/** 命中缓存则返回文件信息，未命中/已过期/文件已被删除则返回 null */
export const getCachedVideo = (key) => {
  if (!key) return null
  const entry = entries.get(key)
  return isEntryFresh(entry) ? entry : null
}

export const setCachedVideo = (key, file) => {
  if (!key || !file || !file.filepath) return
  entries.set(key, { filepath: file.filepath, totalBytes: file.totalBytes, savedAt: Date.now() })
}

export const clearCachedVideo = (key) => {
  if (key) entries.delete(key)
}

/**
 * 同一 key 单飞去重：若该 key 已有进行中的任务则等待并复用其结果，否则执行 producer 一次。
 * 适合「下载文件」这类昂贵的网络操作。
 * @param {string} key
 * @param {() => Promise<T>} producer
 * @returns {Promise<T>}
 */
export const runSingleFlight = async (key, producer) => {
  if (!key) return producer()
  const running = inflight.get(key)
  if (running) return running
  const task = Promise.resolve()
    .then(producer)
    .finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

// ============================================================
// 平台解析结果缓存（数据层）
// 同一视频在多个群连续转发时，复用 getDouyinData/getBilibiliData 等平台 API 的返回结果，
// 避免对同一资源重复请求平台 API（限流与延迟的主要来源）。
// 注意：仅缓存「数据」，不缓存「发送动作」，每个群仍会独立渲染、发送与回复。
// ============================================================

const isDataFresh = (entry) => {
  if (!entry) return false
  return Date.now() - entry.savedAt <= DATA_TTL
}

/** 命中解析结果缓存则返回数据，未命中/已过期返回 null */
export const getCachedData = (key) => {
  if (!key) return null
  const entry = dataEntries.get(key)
  return isDataFresh(entry) ? entry.data : null
}

export const setCachedData = (key, data) => {
  if (!key || data === undefined || data === null) return
  dataEntries.set(key, { data, savedAt: Date.now() })
}

export const clearCachedData = (key) => {
  if (key) dataEntries.delete(key)
}

/**
 * 解析结果单飞去重：同一 key 的解析进行中则复用其结果，避免多群并发时重复请求平台 API。
 * @param {string} key
 * @param {() => Promise<T>} producer
 * @returns {Promise<T>}
 */
export const runSingleFlightData = async (key, producer) => {
  if (!key) return producer()
  const running = dataInflight.get(key)
  if (running) return running
  const task = Promise.resolve()
    .then(producer)
    .finally(() => dataInflight.delete(key))
  dataInflight.set(key, task)
  return task
}