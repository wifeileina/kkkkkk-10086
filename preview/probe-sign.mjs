const path = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs'
const mod = await import(path + '?t=' + Date.now())
const s = mod.xiaohongshuSign
const u = mod.xiaohongshuUtils
console.log('SIGN_TYPE=' + (typeof s))
console.log('SIGN_KEYS=' + JSON.stringify(Object.keys(s || {})))
console.log('SIGN_CLIENT=' + JSON.stringify(Object.keys(s?.client || {})))
console.log('SIGN_GETSEARCHID=' + s?.getSearchId?.toString().slice(0, 200))
console.log('UTILS_SIGN=' + (typeof u?.sign) + ' KEYS=' + JSON.stringify(Object.keys(u || {})))
console.log('APIURLS=' + JSON.stringify(mod.xiaohongshuApiUrls))
process.exit(0)