import { Render, Version } from '../module/utils/index.js'
import fs from 'node:fs'

export class kkkHelp extends plugin {
  constructor() {
    super({
      name: 'kkk帮助',
      event: 'message',
      priority: 2000,
      rule: [
        {
          reg: '^#?xk解析帮助$',
          fnc: 'help'
        },
        {
          reg: '^#?xk解析(版本|更新日志|更新)$',
          fnc: 'version'
        }
      ]
    })
  }

  async version(e) {
    const changelogs = fs.readFileSync(Version.pluginPath + '/CHANGELOG.md', 'utf8')
    const img = await Render('other/changelog', {
      title: '小卡解析更新日志',
      markdown: changelogs,
      version: Version.version
    })
    await e.reply(img)
    return true
  }

  async help(e) {
    const role = e.isMaster ? 'master' : 'member'
    const img = await Render('other/help', {
      title: '小卡解析帮助',
      role
    })
    await e.reply(img)
    return true
  }
}