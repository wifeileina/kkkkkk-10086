import Version from '../utils/Version.js'
import sqlite3 from 'sqlite3'
import path from 'node:path'
import fs from 'node:fs'

const PLATFORMS = ['douyin', 'bilibili', 'kuaishou', 'xiaohongshu']

export class StatisticsDBBase {
  /** @type {sqlite3.Database | null} */
  db = null
  /** @type {string} */
  dbPath

  constructor() {
    this.dbPath = path.join(Version.pluginPath, 'data', 'statistics.db')
  }

  async init() {
    try {
      logger.debug(logger.green('--------------------------[StatisticsDB] 开始初始化数据库--------------------------'))
      await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true })
      this.db = new sqlite3.Database(this.dbPath)
      await this.createTables()
      await this.initGlobalStatistics()
      await this.syncHistoryFromStats()
      await this.seedDailyFromStats()
      logger.debug(logger.green('--------------------------[StatisticsDB] 初始化数据库完成--------------------------'))
    } catch (error) {
      logger.error('[StatisticsDB] 数据库初始化失败:', error)
      throw error
    }
    return this
  }

  async createTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS ParseStatistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        userId TEXT NOT NULL,
        platform TEXT NOT NULL,
        parseCount INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(groupId, userId, platform)
      )`,
      `CREATE TABLE IF NOT EXISTS ParseHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        totalParses INTEGER DEFAULT 0,
        douyin INTEGER DEFAULT 0,
        bilibili INTEGER DEFAULT 0,
        kuaishou INTEGER DEFAULT 0,
        xiaohongshu INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS GlobalStatistics (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      // 按「日期 + 群 + 平台」记录解析量，用于日/周/月维度的群组排行
      `CREATE TABLE IF NOT EXISTS ParseDailyGroup (
        date TEXT NOT NULL,
        groupId TEXT NOT NULL,
        platform TEXT NOT NULL,
        parseCount INTEGER DEFAULT 0,
        PRIMARY KEY (date, groupId, platform)
      )`,
      // 按「日期 + 用户 + 群 + 平台」记录解析量，用于日/周/月维度的个人排行
      `CREATE TABLE IF NOT EXISTS ParseDailyUser (
        date TEXT NOT NULL,
        userId TEXT NOT NULL,
        groupId TEXT NOT NULL,
        platform TEXT NOT NULL,
        parseCount INTEGER DEFAULT 0,
        PRIMARY KEY (date, userId, groupId, platform)
      )`
    ]

    for (const query of queries) {
      await this.runQuery(query)
    }
  }

  async initGlobalStatistics() {
    for (const key of ['totalGroups', 'totalParses']) {
      const exists = await this.getQuery('SELECT * FROM GlobalStatistics WHERE key = ?', [key])
      if (!exists) {
        await this.runQuery('INSERT INTO GlobalStatistics (key, value, updatedAt) VALUES (?, ?, ?)', [
          key,
          '0',
          new Date().toISOString()
        ])
      }
    }
  }

  runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db?.run(sql, params, function (err) {
        if (err) {
          reject(err)
        } else {
          resolve({ lastID: this.lastID, changes: this.changes })
        }
      })
    })
  }

  getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db?.get(sql, params, (err, row) => {
        if (err) {
          reject(err)
        } else {
          resolve(row)
        }
      })
    })
  }

  allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db?.all(sql, params, (err, rows) => {
        if (err) {
          reject(err)
        } else {
          resolve(rows)
        }
      })
    })
  }

  async recordParse(groupId, userId, platform) {
    if (!PLATFORMS.includes(platform)) return

    const now = new Date().toISOString()
    const today = now.split('T')[0]
    const existing = await this.getQuery(
      'SELECT * FROM ParseStatistics WHERE groupId = ? AND userId = ? AND platform = ?',
      [groupId, userId, platform]
    )

    if (existing) {
      await this.runQuery(
        'UPDATE ParseStatistics SET parseCount = parseCount + 1, updatedAt = ? WHERE groupId = ? AND userId = ? AND platform = ?',
        [now, groupId, userId, platform]
      )
    } else {
      await this.runQuery(
        'INSERT INTO ParseStatistics (groupId, userId, platform, parseCount, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
        [groupId, userId, platform, now, now]
      )
      await this.refreshTotalGroups()
    }

    await this.incrementTotalParses()
    await this.updateDailyHistory(today, platform)
    await this.updateDailyGroup(today, groupId, platform)
    await this.updateDailyUser(today, groupId, userId, platform)
  }

  async updateDailyGroup(date, groupId, platform) {
    const existing = await this.getQuery('SELECT * FROM ParseDailyGroup WHERE date = ? AND groupId = ? AND platform = ?', [
      date,
      groupId,
      platform
    ])
    if (existing) {
      await this.runQuery('UPDATE ParseDailyGroup SET parseCount = parseCount + 1 WHERE date = ? AND groupId = ? AND platform = ?', [
        date,
        groupId,
        platform
      ])
      return
    }

    await this.runQuery('INSERT INTO ParseDailyGroup (date, groupId, platform, parseCount) VALUES (?, ?, ?, 1)', [
      date,
      groupId,
      platform
    ])
  }

  async updateDailyUser(date, groupId, userId, platform) {
    const existing = await this.getQuery('SELECT * FROM ParseDailyUser WHERE date = ? AND userId = ? AND groupId = ? AND platform = ?', [
      date,
      userId,
      groupId,
      platform
    ])
    if (existing) {
      await this.runQuery('UPDATE ParseDailyUser SET parseCount = parseCount + 1 WHERE date = ? AND userId = ? AND groupId = ? AND platform = ?', [
        date,
        userId,
        groupId,
        platform
      ])
      return
    }

    await this.runQuery('INSERT INTO ParseDailyUser (date, userId, groupId, platform, parseCount) VALUES (?, ?, ?, ?, 1)', [
      date,
      userId,
      groupId,
      platform
    ])
  }

  async updateDailyHistory(date, platform) {
    const existing = await this.getQuery('SELECT * FROM ParseHistory WHERE date = ?', [date])
    if (existing) {
      await this.runQuery(`UPDATE ParseHistory SET totalParses = totalParses + 1, ${platform} = ${platform} + 1 WHERE date = ?`, [date])
      return
    }

    await this.runQuery(
      'INSERT INTO ParseHistory (date, totalParses, douyin, bilibili, kuaishou, xiaohongshu, createdAt) VALUES (?, 1, ?, ?, ?, ?, ?)',
      [
        date,
        platform === 'douyin' ? 1 : 0,
        platform === 'bilibili' ? 1 : 0,
        platform === 'kuaishou' ? 1 : 0,
        platform === 'xiaohongshu' ? 1 : 0,
        new Date().toISOString()
      ]
    )
  }

  async syncHistoryFromStats() {
    const historyCount = await this.getQuery('SELECT COUNT(*) as count FROM ParseHistory')
    if (historyCount?.count > 0) return

    const allStats = await this.getAllStatistics()
    const dateMap = new Map()
    for (const stat of allStats) {
      const date = stat.createdAt.split('T')[0]
      if (!dateMap.has(date)) {
        dateMap.set(date, { douyin: 0, bilibili: 0, kuaishou: 0, xiaohongshu: 0 })
      }
      dateMap.get(date)[stat.platform] += stat.parseCount
    }

    for (const [date, platforms] of dateMap.entries()) {
      const totalParses = PLATFORMS.reduce((sum, platform) => sum + platforms[platform], 0)
      await this.runQuery(
        'INSERT OR IGNORE INTO ParseHistory (date, totalParses, douyin, bilibili, kuaishou, xiaohongshu, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [date, totalParses, platforms.douyin, platforms.bilibili, platforms.kuaishou, platforms.xiaohongshu, new Date().toISOString()]
      )
    }
  }

  // 群组表与个人表必须由同一份 ParseStatistics 快照、在同一遍内回填，否则两边会在不同时间
  // 用不同的累计值落库，导致同一天的群组合计与个人合计对不上。这里在初始化时校验两表各日合计，
  // 不一致就整体重建（历史累计量按「最后解析日」回填，让周/月排行立刻有数据）。
  async seedDailyFromStats() {
    const groupRows = await this.allQuery('SELECT date, SUM(parseCount) AS total FROM ParseDailyGroup GROUP BY date')
    const userRows = await this.allQuery('SELECT date, SUM(parseCount) AS total FROM ParseDailyUser GROUP BY date')
    const groupMap = new Map(groupRows.map(row => [row.date, row.total]))
    const userMap = new Map(userRows.map(row => [row.date, row.total]))
    const consistent =
      groupMap.size === userMap.size && [...groupMap].every(([date, total]) => userMap.get(date) === total)
    if (consistent && groupMap.size > 0) return

    const allStats = await this.getAllStatistics()
    await this.runQuery('DELETE FROM ParseDailyGroup')
    await this.runQuery('DELETE FROM ParseDailyUser')
    if (!allStats.length) return

    const groupAgg = new Map()
    for (const stat of allStats) {
      const date = String(stat.updatedAt || stat.createdAt || '').split('T')[0]
      if (!date) continue
      // 同一群同平台可能有多名用户，群组表必须按群聚合，否则 INSERT OR IGNORE 会丢掉后写入的用户
      const key = `${date}|${stat.groupId}|${stat.platform}`
      groupAgg.set(key, (groupAgg.get(key) || 0) + stat.parseCount)
      await this.runQuery(
        'INSERT OR IGNORE INTO ParseDailyUser (date, userId, groupId, platform, parseCount) VALUES (?, ?, ?, ?, ?)',
        [date, stat.userId, stat.groupId, stat.platform, stat.parseCount]
      )
    }

    for (const [key, total] of groupAgg) {
      const [date, groupId, platform] = key.split('|')
      await this.runQuery(
        'INSERT OR IGNORE INTO ParseDailyGroup (date, groupId, platform, parseCount) VALUES (?, ?, ?, ?)',
        [date, groupId, platform, total]
      )
    }
  }

  async getGroupStatistics(groupId) {
    return await this.allQuery('SELECT * FROM ParseStatistics WHERE groupId = ? ORDER BY platform, userId', [groupId])
  }

  async getGroupUniqueUsers(groupId) {
    const result = await this.getQuery('SELECT COUNT(DISTINCT userId) as count FROM ParseStatistics WHERE groupId = ?', [groupId])
    return result?.count || 0
  }

  async getTotalUniqueUsers() {
    const result = await this.getQuery('SELECT COUNT(DISTINCT userId) as count FROM ParseStatistics')
    return result?.count || 0
  }

  async getAllStatistics() {
    return await this.allQuery('SELECT * FROM ParseStatistics ORDER BY groupId, platform')
  }

  // 按最近 days 天（含今天）聚合群组解析量排行；days=1 即仅今天
  async getTopGroupsByRange(days = 1, limit = 10) {
    const start = new Date()
    start.setDate(start.getDate() - (Math.max(1, days) - 1))
    const from = start.toISOString().slice(0, 10)
    return await this.allQuery(
      'SELECT groupId, SUM(parseCount) as total FROM ParseDailyGroup WHERE date >= ? GROUP BY groupId ORDER BY total DESC LIMIT ?',
      [from, limit]
    )
  }

  // 按最近 days 天（含今天）聚合个人解析量排行；附带一个群号用于解析昵称
  async getTopUsersByRange(days = 1, limit = 10) {
    const start = new Date()
    start.setDate(start.getDate() - (Math.max(1, days) - 1))
    const from = start.toISOString().slice(0, 10)
    return await this.allQuery(
      'SELECT userId, MAX(groupId) as groupId, SUM(parseCount) as total FROM ParseDailyUser WHERE date >= ? GROUP BY userId ORDER BY total DESC LIMIT ?',
      [from, limit]
    )
  }

  // 清除全部解析统计（累计统计、历史趋势、按日群组/个人统计一并清空）
  async resetStatistics() {
    await this.runQuery('DELETE FROM ParseStatistics')
    await this.runQuery('DELETE FROM ParseHistory')
    await this.runQuery('DELETE FROM ParseDailyGroup')
    await this.runQuery('DELETE FROM ParseDailyUser')
    for (const key of ['totalParses', 'totalGroups']) {
      await this.runQuery('UPDATE GlobalStatistics SET value = ?, updatedAt = ? WHERE key = ?', [
        '0',
        new Date().toISOString(),
        key
      ])
    }
  }

  async getRecentHistory(days = 30) {
    return await this.allQuery('SELECT * FROM ParseHistory ORDER BY date DESC LIMIT ?', [days])
  }

  async getPlatformTotalParses(platform) {
    const result = await this.getQuery('SELECT SUM(parseCount) as total FROM ParseStatistics WHERE platform = ?', [platform])
    return result?.total || 0
  }

  async getTotalGroups() {
    const result = await this.getQuery('SELECT COUNT(DISTINCT groupId) as count FROM ParseStatistics')
    return result?.count || 0
  }

  async getTotalParses() {
    const result = await this.getQuery('SELECT value FROM GlobalStatistics WHERE key = ?', ['totalParses'])
    return Number.parseInt(result?.value || '0', 10)
  }

  async refreshTotalGroups() {
    const totalGroups = await this.getTotalGroups()
    await this.runQuery('UPDATE GlobalStatistics SET value = ?, updatedAt = ? WHERE key = ?', [
      String(totalGroups),
      new Date().toISOString(),
      'totalGroups'
    ])
  }

  async incrementTotalParses() {
    await this.runQuery('UPDATE GlobalStatistics SET value = value + 1, updatedAt = ? WHERE key = ?', [
      new Date().toISOString(),
      'totalParses'
    ])
  }

  async getGlobalSummary() {
    return {
      totalGroups: await this.getTotalGroups(),
      totalParses: await this.getTotalParses(),
      totalUsers: await this.getTotalUniqueUsers(),
      platformStats: {
        douyin: await this.getPlatformTotalParses('douyin'),
        bilibili: await this.getPlatformTotalParses('bilibili'),
        kuaishou: await this.getPlatformTotalParses('kuaishou'),
        xiaohongshu: await this.getPlatformTotalParses('xiaohongshu')
      }
    }
  }
}
