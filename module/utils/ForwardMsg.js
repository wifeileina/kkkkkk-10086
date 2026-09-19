import common from '../../../../lib/common/common.js'
import fs from 'node:fs'

// QQ 合并转发单条上限 100 个节点，标题（description）本身占 1 个节点，
// 故每批最多塞 99 条消息，超过则拆分出下一个合并转发。
export const MAX_FORWARD_NODES = 100
export const MAX_FORWARD_MESSAGES = MAX_FORWARD_NODES - 1

// OneBot/QQBot 适配器在发送合并转发时，会把节点里带 file/base64 的段内联转成 base64 字符串。
// 多个大体积本地视频（如实况图）会让单个转发帧超过 NapCat 反向 WS 的 100MB maxPayload 而断开。
// 因此除按条数限外，还需按估算字节预算切批，保证任一帧都远低于 100MB。
export const MAX_FORWARD_BYTES = 40 * 1024 * 1024

const estimateWeight = (msg) => {
  const files = new Set()
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (typeof o.file === 'string' && o.file) files.add(o.file)
    for (const k of Object.keys(o)) {
      if (k !== 'file') walk(o[k])
    }
  }
  walk(msg)
  let weight = Buffer.byteLength(JSON.stringify(msg ?? ''))
  for (const file of files) {
    let local = file
    if (local.startsWith('file://')) local = local.slice('file://'.length)
    if (local.startsWith('base64://')) {
      weight += Buffer.byteLength(local) * 0.75 // base64 字符串 → 原始字节
    } else {
      try {
        const stat = fs.statSync(local)
        if (stat.isFile()) weight += stat.size
      } catch { /* 远程/不存在时以 JSON 长度计 */ }
    }
  }
  return weight
}

const makeBatches = (list, limit, byteLimit) => {
  if (list.length <= limit && list.reduce((a, m) => a + estimateWeight(m), 0) <= byteLimit) {
    return [list]
  }
  const weights = list.map(estimateWeight)
  const batches = []
  let cur = []
  let curSize = 0
  for (let i = 0; i < list.length; i++) {
    const msg = list[i]
    const w = weights[i]
    if ((cur.length >= limit) || (cur.length && curSize + w > byteLimit)) {
      batches.push(cur)
      cur = []
      curSize = 0
    }
    cur.push(msg)
    curSize += w
  }
  if (cur.length) batches.push(cur)
  return batches
}

/**
 * 按 QQ 合并转发上限分批构造转发消息（同时按条数与字节预算切批）
 * @param {*} e 消息事件（或 Bot 实例）
 * @param {Array} msgs 消息元素数组
 * @param {string} dec 转发描述（标题）
 * @param {number} [limit] 每批最大消息条数，默认 99（标题节点外留 1 位）
 * @param {number} [byteLimit] 每批最大估算字节，默认 40MB
 * @param {{titleOnce?: boolean}} [options] 标题是否只放在第一批，默认 false
 * @returns {Promise<Array>} 合并转发元素数组，每个元素可直接 e.reply / sendMsg
 */
export const makeForwardMsg = (e, msgs, dec) => common.makeForwardMsg(e, msgs, dec)

export const makeForwardMsgBatched = async (e, msgs, dec, limit = MAX_FORWARD_MESSAGES, byteLimit = MAX_FORWARD_BYTES, options = {}) => {
  const list = Array.isArray(msgs) ? msgs : [msgs]
  const batches = makeBatches(list, limit, byteLimit)
  const total = batches.length
  const result = []
  for (let i = 0; i < total; i++) {
    const chunk = batches[i]
    const batchName = options.titleOnce ? '合辑内容' : dec
    const batchLabel = total > 1 ? `${batchName} (${i + 1}/${total})` : null
    const title = options.titleOnce ? (i === 0 ? dec : undefined) : (batchLabel ? batchLabel : dec)
    const messages = options.titleOnce && batchLabel ? [batchLabel, ...chunk] : chunk
    result.push(await common.makeForwardMsg(e, messages, title))
  }
  return result
}