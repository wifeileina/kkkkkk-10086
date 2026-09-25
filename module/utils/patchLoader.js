// 插件内覆写框架消息节流：给 loader.checkLimit 的节流 key 增加群维度。
// 注意：此文件正常不会被 bot 更新覆盖（仅插件自身），lib 源文件保持不动。
// 效果：同一用户在同一秒把同一内容发到多个不同群时，不再被 loader.js 静默丢弃，各群都能进入解析；
//       同群内重复发送仍按 1 秒窗口节流，保留框架原有的防刷屏意图。
import cfg from '../../../../lib/config/config.js'
import PluginsLoader from '../../../../lib/plugins/loader.js'

if (!PluginsLoader.__kkk_msgThrottleGroupPatched__) {
  PluginsLoader.__kkk_msgThrottleGroupPatched__ = true

  PluginsLoader.checkLimit = function (e, config) {
    /** 禁言中 */
    if (
      e.group &&
      (e.group.mute_left > 0 || (e.group.all_muted && !e.group.is_admin && !e.group.is_owner))
    )
      return false
    if (!e.message || e.isPrivate) return true

    config ||= cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD && this.groupCD[e.group_id]) return false
    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`]) return false

    // 与原版唯一差异：key 增加群维度，跨群同内容并发不再互相节流丢弃；同群重复仍被拦截
    const msgId = `${e.self_id}:${e.user_id}:${e.group_id || ''}:${e.raw_message}`
    if (this.msgThrottle[msgId]) return false
    this.msgThrottle[msgId] = true
    setTimeout(() => delete this.msgThrottle[msgId], 1000)

    return true
  }

  logger.mark('[kkkkkk-10086] 已注入 loader.checkLimit：消息节流 key 增加群维度')
}