/**
 * 简单并发控制队列
 * 用于限制同一平台 API 的同时请求数，避免因 Cookie/IP 限流而静默失败。
 * 超出并发上限的任务自动排队，等待有槽位后执行。
 */
import Config from './Config.js'

export class ConcurrencyQueue {
  /**
   * @param {() => number} [getMaxConcurrency] 动态获取最大并发数的函数
   */
  constructor(getMaxConcurrency) {
    this.getMaxConcurrency = getMaxConcurrency || (() => 2)
    this.active = 0
    this.waiting = []
  }

  /** 当前生效的最大并发数 */
  get maxConcurrency() {
    return Math.max(1, Math.floor(this.getMaxConcurrency()))
  }

  /**
   * 执行一个任务，超出并发上限时排队等待
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async run(task) {
    if (this.active >= this.maxConcurrency) {
      await new Promise(resolve => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      const next = this.waiting.shift()
      if (next) next()
    }
  }

  /** 当前排队中的任务数 */
  get pending() {
    return this.waiting.length
  }
}

/**
 * 读取单平台解析并发数配置的通用函数
 * @param {string} platform Config 中对应的平台key（douyin/bilibili/kuaishou/xiaohongshu）
 * @returns {number}
 */
function readPlatformParseConcurrency(platform) {
  try {
    const conf = Config?.[platform]
    const value = Number(conf?.parseConcurrency ?? conf?.concurrency ?? 2)
    return Number.isFinite(value) && value > 0 ? value : 2
  } catch {
    return 2
  }
}

/** 各平台独立解析并发队列，全局单例。
 * 每个平台独立排队，互不阻塞，避免跨平台请求串行等待。 */
export const douyinParseQueue = new ConcurrencyQueue(() => readPlatformParseConcurrency('douyin'))
export const bilibiliParseQueue = new ConcurrencyQueue(() => readPlatformParseConcurrency('bilibili'))
export const kuaishouParseQueue = new ConcurrencyQueue(() => readPlatformParseConcurrency('kuaishou'))
export const xiaohongshuParseQueue = new ConcurrencyQueue(() => readPlatformParseConcurrency('xiaohongshu'))