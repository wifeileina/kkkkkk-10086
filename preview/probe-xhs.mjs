const path = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs'
const mod = await import(path + '?t=' + Date.now())
const probe = (obj, depth) => {
  const keys = []
  for (const k of Object.keys(obj || {})) keys.push(k)
  return keys
}
console.log('SIGN_KEYS=' + JSON.stringify(probe(mod.xiaohongshuSign)))
console.log('FETCH_KEYS=' + JSON.stringify(probe(mod.xiaohongshuFetcher)))
console.log('UTILS_KEYS=' + JSON.stringify(probe(mod.xiaohongshuUtils)))
console.log('ROUTES=' + JSON.stringify(probe(mod.xiaohongshuApiUrls)))
process.exit(0)