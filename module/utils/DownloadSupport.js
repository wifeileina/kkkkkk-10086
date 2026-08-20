import { randomUUID } from 'node:crypto'

const douyinHostPattern = /(^|\.)douyinvod\.com$/i

export const isDouyinCdnUrl = (url) => {
  try {
    return douyinHostPattern.test(new URL(url).hostname)
  } catch {
    return false
  }
}

export const createTempVideoTitle = (extension = '.mp4') => {
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`
  return `tmp_${Date.now()}_${randomUUID()}${normalizedExtension}`
}

export const buildDouyin403Fallback = (url, attempt) => {
  if (!isDouyinCdnUrl(url) || attempt > 0) return null

  return {
    resetPartialFile: true,
    headers: {
      Referer: 'https://www.douyin.com/',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'close'
    }
  }
}
