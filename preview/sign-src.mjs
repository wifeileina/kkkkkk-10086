const path = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs'
const mod = await import(path + '?t=' + Date.now())
const source = mod.xiaohongshuUtils.sign.toString()
console.log(source.slice(0, 2500))
process.exit(0)