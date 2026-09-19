import { update } from '../../../plugins/other/update.js'
import Version from '../module/utils/Version.js'

export class kkkUpdate extends plugin {
  constructor () {
    super({
      name: '更新',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: /^#?xk解析(强制)?更新(日志)?$/,
          fnc: 'update'
        }
      ]
    })
  }

  async update (e) {
    let msg = e.msg
    if (!msg.includes('日志') && !e.isMaster) return false
    if (msg.includes('强制') && msg.includes('日志')) {
      msg = msg.replace('强制', '')
    }
    msg = msg.replace(/^#?xk解析/, '')
    msg += Version.pluginName
    e.msg = msg
    const up = new update(e)
    up.e = e
    e.msg.includes('日志') ? up.updateLog() : up.update()
    return true
  }
}
