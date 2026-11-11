import fs from 'node:fs'
import path from 'node:path'
import Config from './Config.js'
import Common from './Common.js'
import { clearAllCache, getMemoryCacheCounts } from './ResourceCache.js'

/**
 * 插件缓存管理
 * - 磁盘缓存：temp/kkkkkk-10086/kkkdownload 下的 video / images
 * - 内存缓存：ResourceCache（已下载文件/链接、平台解析结果）
 * 改画质后若不清缓存，10 分钟内会继续复用旧文件/旧解析结果，看起来像设置没生效。
 */

/** 递归统计目录下的文件数与字节数 */
const measureDir = async (dir) => {
  const result = { files: 0, bytes: 0 }
  if (!dir) return result
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const child = await measureDir(target)
      result.files += child.files
      result.bytes += child.bytes
      continue
    }
    try {
      const stat = await fs.promises.stat(target)
      result.files += 1
      result.bytes += stat.size
    } catch {
      // 文件在统计过程中被删除，忽略
    }
  }
  return result
}

/** 递归清空目录内容（保留目录本身，避免后续写入需要重建） */
const clearDir = async (dir) => {
  if (!dir) return
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(dir, entry.name)
    try {
      await fs.promises.rm(target, { recursive: true, force: true })
    } catch {
      // 文件被占用/已删除，跳过
    }
  }))
}

const cacheDirs = () => ({
  video: Common.tempDri.video,
  images: Common.tempDri.images
})

/** 当前缓存占用（磁盘 + 内存） */
export const getCacheStats = async () => {
  const dirs = cacheDirs()
  const [video, images] = await Promise.all([measureDir(dirs.video), measureDir(dirs.images)])
  const memory = getMemoryCacheCounts()
  return {
    video,
    images,
    disk: { files: video.files + images.files, bytes: video.bytes + images.bytes },
    memory,
    removeCache: Config.app?.removeCache === true,
    cacheRetentionMinutes: Config.app?.cacheRetentionMinutes ?? 10
  }
}

/**
 * 清空全部缓存：内存缓存 + 磁盘视频/图片缓存。
 * 清空后再次解析会重新走平台接口并按当前画质设置下载。
 * @returns {Promise<{freed: {files:number, bytes:number, video:number, data:number}}>}
 */
export const clearCache = async () => {
  const before = await getCacheStats()
  const memory = clearAllCache()
  Common.videoPreviews?.clear?.()

  const dirs = cacheDirs()
  await Promise.all([clearDir(dirs.video), clearDir(dirs.images)])

  return {
    freed: {
      files: before.disk.files,
      bytes: before.disk.bytes,
      video: memory.video,
      data: memory.data
    }
  }
}
