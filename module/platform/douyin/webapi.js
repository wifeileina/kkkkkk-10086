import puppeteer from 'puppeteer'
import fs from 'node:fs'
import os from 'node:os'
import { newInjectedPage } from 'fingerprint-injector'

/**
 * 抖音 Web API 详情请求模块（浏览器方案）。
 *
 * 背景：抖音 Web API（/aweme/v1/web/aweme/detail/）新增 ArgusSecurityPlugin 风控，
 * 对所有请求校验 UIFID 设备令牌。UIFID 必须由浏览器内的 webmssdk JS 动态生成再烙进签名，
 * 纯 HTTP（含旧 a_bogus [0,1,14]、新版 [0,1,8]、ttwid、甚至复制完整登录 cookie）均返回
 * 403「Uifid Not Found」，常见的媒体解析插件同样无法绕过。
 *
 * 可行方案：用无头浏览器打开抖音首页，让 webmssdk 生成 UIFID 等风控 cookie，再在页面上下文中
 * 直接 fetch detail 接口（credentials:'include' 带页面完整 cookie 与上下文），即可拿到完整
 * aweme_detail——含动图/实况图所需的 images[].clip_type 与 images[].video 字段。
 *
 * 输出沿用原契约 { data: { aweme_detail } }，供 douyin.js 直接消费，无需改动上层。
 */

const DOUYIN_HOME = 'https://www.douyin.com/'

/**
 * 全局浏览器解析串行闸（防风控）。
 * 同一时刻只允许一个浏览器解析存活，其余请求排队等待。
 * 设计上：一个完成解析后，其余同作品直接复用缓存数据/文件发送，而非各自重复请求平台接口，
 * 从而避免多群并发重复请求被抖音限流静默失败。
 */
let browserGate = Promise.resolve()
const runExclusive = (task) => {
  const run = browserGate.then(task)
  browserGate = run.then(() => {}, () => {})
  return run
}

/**
 * 浏览器单例 + 闲置自动退出。
 * 详情页需要 webmssdk 初始化 UIFID（首次约 5s），复用浏览器可避免每次解析都冷启动一个 Chromium。
 * 闲置超过 maxIdleMs 后在后台自动 close，避免长期常驻占内存。
 */
let sharedBrowser = null
let sharedBrowserTimer = null
const BROWSER_IDLE_MS = 120000

const launchBrowser = async () => {
  const executablePath = getChromeExecutablePath()
  return puppeteer.launch({
    headless: 'new',
    ...(executablePath ? { executablePath } : {}),
    protocolTimeout: 60000,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      '--window-size=800,600',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      '--disable-notifications',
      '--disable-translate',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=512'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  })
}

/** 获取单例浏览器；空闲计时器在首次取用时取消。 */
const getSharedBrowser = async () => {
  if (sharedBrowserTimer) {
    clearTimeout(sharedBrowserTimer)
    sharedBrowserTimer = null
  }
  if (!sharedBrowser) {
    sharedBrowser = await launchBrowser()
    // 启动阶段即开启退出兜底，防止异常路径导致浏览器常驻堆积
    scheduleBrowserClose()
  }
  return sharedBrowser
}

/** 标记闲置，稍后（无新任务时）自动关闭单例浏览器。 */
const scheduleBrowserClose = () => {
  if (sharedBrowserTimer) clearTimeout(sharedBrowserTimer)
  sharedBrowserTimer = setTimeout(async () => {
    sharedBrowserTimer = null
    if (!sharedBrowser) return
    const b = sharedBrowser
    sharedBrowser = null
    try { await b.close() } catch { /* 已关闭忽略 */ }
  }, BROWSER_IDLE_MS)
  if (sharedBrowserTimer.unref) sharedBrowserTimer.unref()
}

const getOperatingSystem = () => {
  const platform = os.platform()
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

const getChromeExecutablePath = () => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean)
  return candidates.find(item => fs.existsSync(item))
}

/** 页面内用完整风控 cookie 请求详情，返回完整 aweme_detail（可结构化克隆）。 */
const fetchDetailInPage = (page, awemeId) => page.evaluate(async (awemeId) => {
  const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${awemeId}`
  const resp = await fetch(url, { credentials: 'include' })
  let json = null
  try { json = await resp.json() } catch { json = null }
  const detail = json?.aweme_detail || null
  return {
    status: resp.status,
    status_code: json?.status_code,
    aweme_id: detail?.aweme_id || null,
    detail
  }
}, awemeId)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 当前正在进行的浏览器解析数（用于并发时避免关闭仍被他人使用的共享浏览器） */
let activeBrowserParses = 0

/**
 * 通过无头浏览器获取完整 aweme_detail（携带 UIFID，可绕过 Argus 风控）。
 * 失败或超时时抛出异常，由上层降级到分享页解析。
 * 全程走「全局串行闸 + 浏览器单例 + 闲置自动退出」，同一时刻仅一个 Chromium 存活，
 * 多群并发仅浏览器取数串行，其余复用缓存数据/文件发送，避免限流与内存峰值。
 * @param {string} awemeId 作品 ID
 * @returns {Promise<{ data: { aweme_detail: Object } }>}
 */
export const fetchDouyinDetailViaBrowser = (awemeId) => runExclusive(async () => {
  activeBrowserParses++
  const browser = await getSharedBrowser()
  let page
  try {
    page = await newInjectedPage(browser, {
      fingerprintOptions: {
        devices: ['desktop'],
        operatingSystems: [getOperatingSystem()]
      }
    })

    // 注意：为让页面 webmssdk 完整初始化并包装全局 fetch（自动追加 a_bogus/UIFID），
    // 这里不启用请求拦截，否则可能破坏 SDK 或提前发请求导致 403。
    await page.goto(DOUYIN_HOME, { timeout: 60000, waitUntil: 'domcontentloaded' })
    // 等待 webmssdk 完成 UIFID 生成与 fetch 签名包装（固定等待与验证探针一致）
    await sleep(5000)

    const result = await Promise.race([
      fetchDetailInPage(page, awemeId),
      sleep(30000).then(() => ({ __timeout: true }))
    ])

    if (result?.__timeout) throw new Error('浏览器(详情)请求超时')
    if (result?.status !== 200 || result?.status_code !== 0) throw new Error(`浏览器(详情)风控失败 status=${result?.status} code=${result?.status_code}`)
    if (!result?.detail || String(result.aweme_id) !== String(awemeId)) throw new Error('浏览器(详情)未匹配到目标作品')

    return { data: { aweme_detail: result.detail } }
  } catch (error) {
    // 页面或请求异常时：仅当没有其他解析正共用同一浏览器（无并发），才关闭并置空单例，
    // 避免连累其他并发任务；并发场景下交给闲置计时自动回收及下次复用前的健壮性保障。
    if (activeBrowserParses === 1 && sharedBrowser) {
      await sharedBrowser.close().catch(() => {})
      sharedBrowser = null
    }
    throw error
  } finally {
    activeBrowserParses--
    try { if (page) await page.close().catch(() => {}) } catch { /* 忽略 */ }
    // 本次解析结束，进入闲置倒计时；有新任务会取消它复用同一浏览器
    scheduleBrowserClose()
  }
})