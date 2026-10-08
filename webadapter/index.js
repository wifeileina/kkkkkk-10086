/**
 * kkkkkk-10086 WebAdapter 操作模块
 * 由 QQBot-Web-Adapter 自动扫描并调用 init(ctx)
 *
 * 配置读写直接复用 guoba.support.js 的 schemas / getConfigData / setConfigData，
 * 保证「锅巴面板能配的，这里都能配」，避免两套配置定义各自漂移。
 */
import Config from '../module/utils/Config.js'
import Version from '../module/utils/Version.js'
import { supportGuoba } from '../guoba.support.js'
import { getStatisticsDB } from '../module/db/index.js'

const PLATFORM_LABELS = {
  douyin: '抖音',
  bilibili: '哔哩哔哩',
  kuaishou: '快手',
  xiaohongshu: '小红书'
}

// 群组排行的统计时间维度：days 含今天
const STATS_RANGES = {
  day: { days: 1, label: '今天' },
  week: { days: 7, label: '近 7 天' },
  month: { days: 30, label: '近 30 天' }
}

const guoba = supportGuoba()
const { schemas, getConfigData, setConfigData } = guoba.configInfo

// 只允许写入 schema 中声明过的字段，避免任意配置键被外部接口写入
const ALLOWED_FIELDS = new Set(schemas.filter(item => item.field).map(item => item.field))

const Result = {
  ok: (data = {}, msg = '') => ({ ok: true, data, msg }),
  error: (msg = '', error) => ({ ok: false, msg, error: error?.message || String(error || '') })
}

const safe = fn => (_req, res) => {
  try {
    Promise.resolve(fn(_req, res)).catch(error => {
      res.json({ ok: false, error: error?.message || String(error) })
    })
  } catch (error) {
    res.json({ ok: false, error: error?.message || String(error) })
  }
}

const getGroupName = groupId => {
  try {
    const gl = globalThis.Bot?.gl
    if (!gl?.get) return ''
    const info = gl.get(Number(groupId)) || gl.get(String(groupId))
    return info?.group_name || ''
  } catch {
    return ''
  }
}

const getMemberName = (groupId, userId) => {
  try {
    const member = globalThis.Bot?.pickGroup?.(Number(groupId))?.pickMember?.(Number(userId))
    return member?.card || member?.nickname || member?.name || ''
  } catch {
    return ''
  }
}

const listGroups = () => {
  const list = []
  try {
    const gl = globalThis.Bot?.gl
    if (!gl?.values) return list
    for (const item of gl.values()) {
      if (!item?.group_id) continue
      list.push({
        group_id: String(item.group_id),
        group_name: item.group_name || '',
        member_count: Number.isFinite(item.member_count) ? item.member_count : null,
        max_member_count: Number.isFinite(item.max_member_count) ? item.max_member_count : null,
        avatar: `https://p.qlogo.cn/gh/${item.group_id}/${item.group_id}/100`
      })
    }
  } catch {
    // Bot 未就绪时返回空列表，不阻塞页面
  }
  return list.sort((a, b) => Number(b.group_id) - Number(a.group_id))
}

// 历史表只在有解析记录时写入，缺失的日期补 0，保证「近 14 天趋势」始终是完整 14 根柱
const fillHistory = (rows = [], days = 14) => {
  const byDate = new Map(rows.map(row => [row.date, row]))
  const today = new Date()
  const list = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const row = byDate.get(key)
    list.push({
      date: key,
      total: row?.totalParses || 0,
      douyin: row?.douyin || 0,
      bilibili: row?.bilibili || 0,
      kuaishou: row?.kuaishou || 0,
      xiaohongshu: row?.xiaohongshu || 0
    })
  }
  return list
}

export function init(ctx) {
  const { registerPage, registerApi } = ctx

  registerPage({
    id: 'kkkkkk-10086',
    title: '小卡解析',
    icon: '🎬',
    priority: 60,
    src: 'page.html',
    // 表情可视化选择器的图集目录（webadapter/emoji/*.png），供页面同源引用
    assetsDir: ['emoji']
  })

  // ====== 配置 schema + 当前值 ======
  registerApi('get', '/kkkkkk-10086/config', safe((_req, res) => {
    res.json({
      ok: true,
      data: {
        schemas,
        config: getConfigData(),
        meta: {
          pluginName: Version.pluginName,
          version: Version.version,
          botName: Version.BotName,
          botVersion: Version.BotVersion
        }
      }
    })
  }))

  // ====== 保存配置 ======
  registerApi('post', '/kkkkkk-10086/config', safe(async (req, res) => {
    const body = req.body || {}
    const payload = {}
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_FIELDS.has(key)) payload[key] = value
    }
    if (!Object.keys(payload).length) {
      res.json({ ok: false, error: '没有可写入的配置项' })
      return
    }
    const result = await setConfigData(payload, { Result })
    res.json(result?.ok === false ? { ok: false, error: result.msg || '保存失败' } : { ok: true, msg: '保存成功' })
  }))

  // ====== 运行状态 ======
  registerApi('get', '/kkkkkk-10086/status', safe((_req, res) => {
    const app = Config.app || {}
    const advanced = Config.advanced || {}
    const platforms = [
      { key: 'douyin', cfg: Config.douyin, toolKeys: ['switch'], quality: Config.douyin?.videoQuality, maxSize: Config.douyin?.maxAutoVideoSize, sendContent: Config.douyin?.sendContent },
      { key: 'bilibili', cfg: Config.bilibili, toolKeys: ['switch'], quality: Config.bilibili?.videoQuality, maxSize: Config.bilibili?.maxAutoVideoSize, sendContent: Config.bilibili?.sendContent },
      { key: 'kuaishou', cfg: Config.kuaishou, toolKeys: ['switch'], quality: null, maxSize: null, sendContent: null },
      { key: 'xiaohongshu', cfg: Config.xiaohongshu, toolKeys: ['switch'], quality: Config.xiaohongshu?.videoQuality, maxSize: Config.xiaohongshu?.maxAutoVideoSize, sendContent: Config.xiaohongshu?.sendContent }
    ].map(item => {
      const pick = keys => {
        for (const key of keys) {
          if (item.cfg?.[key] !== undefined && item.cfg?.[key] !== null) return item.cfg[key]
        }
        return undefined
      }
      return {
        key: item.key,
        label: PLATFORM_LABELS[item.key],
        enabled: pick(item.toolKeys) !== false,
        quality: item.quality ?? null,
        maxSize: item.maxSize ?? null,
        sendContent: Array.isArray(item.sendContent) ? item.sendContent : []
      }
    })

    res.json({
      ok: true,
      data: {
        pluginName: Version.pluginName,
        version: Version.version,
        botName: Version.BotName,
        botVersion: Version.BotVersion,
        global: {
          videoTool: app.videoTool !== false,
          privateTool: app.privateTool !== false,
          overLimitCommandParse: app.overLimitCommandParse !== false,
          overLimitCommandParsePermission: app.overLimitCommandParsePermission || 'master',
          defaulttool: app.defaulttool !== false,
          priority: app.priority ?? 0,
          parseTip: app.parseTip === true,
          emojiReply: app.EmojiReply !== false,
          removeCache: app.removeCache === true,
          cacheRetentionMinutes: app.cacheRetentionMinutes ?? 10,
          arbitrationEnabled: app.arbitrationEnabled === true,
          manualParseEnabled: advanced.manualParseEnabled === true,
          parseConcurrency: Config.douyin?.parseConcurrency ?? 1,
          downloadConcurrency: Config.upload?.downloadConcurrency ?? 4
        },
        platforms
      }
    })
  }))

  // ====== 解析统计 ======
  registerApi('get', '/kkkkkk-10086/stats', safe(async (req, res) => {
    const db = await getStatisticsDB()
    if (!db) {
      res.json({ ok: false, error: '统计数据库未就绪' })
      return
    }
    const rangeKey = String(req.query?.range || '').toLowerCase()
    const range = STATS_RANGES[rangeKey] ? rangeKey : 'day'
    const { days, label } = STATS_RANGES[range]

    const [summary, history, topRows, topUserRows] = await Promise.all([
      db.getGlobalSummary(),
      db.getRecentHistory(14),
      db.getTopGroupsByRange(days),
      db.getTopUsersByRange(days)
    ])

    const topGroups = topRows.map(item => ({ ...item, groupName: getGroupName(item.groupId) }))
    const topUsers = topUserRows.map(item => ({
      ...item,
      userName: getMemberName(item.groupId, item.userId),
      groupName: getGroupName(item.groupId)
    }))

    res.json({
      ok: true,
      data: {
        summary,
        range,
        rangeLabel: label,
        platformRows: Object.entries(PLATFORM_LABELS).map(([key, label]) => ({
          key,
          label,
          count: summary.platformStats?.[key] || 0
        })),
        history: fillHistory(history),
        topGroups,
        topUsers
      }
    })
  }))

  // ====== 清除统计 ======
  registerApi('post', '/kkkkkk-10086/stats/reset', safe(async (_req, res) => {
    const db = await getStatisticsDB()
    if (!db) {
      res.json({ ok: false, error: '统计数据库未就绪' })
      return
    }
    await db.resetStatistics()
    res.json({ ok: true, msg: '统计已清除' })
  }))

  // ====== 群组列表 ======
  registerApi('get', '/kkkkkk-10086/groups', safe((_req, res) => {
    const advanced = Config.advanced || {}
    const manualParseGroups = Array.isArray(advanced.manualParseGroups) ? advanced.manualParseGroups.map(String) : []
    res.json({
      ok: true,
      data: {
        groups: listGroups(),
        manualParseEnabled: advanced.manualParseEnabled === true,
        manualParseGroups
      }
    })
  }))
}