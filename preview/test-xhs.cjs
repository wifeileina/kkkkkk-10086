const { xiaohongshuFetcher } = require('/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs')

;(async () => {
  try {
    const r = await xiaohongshuFetcher.fetchNoteDetail({
      note_id: '6a682a42000000000100f695',
      xsec_token: 'ABwYsMMF84fFsVnXRN15-UvY1fvQAybactoCIriOMFJKM'
    }, '')
    const t = JSON.stringify(r)
    console.log('LEN=' + t.length)
    console.log('HEAD=' + t.slice(0, 2500))
    console.log('TAIL=' + t.slice(-500))
  } catch (e) {
    console.log('ERR=' + (e && (e.stack || e.message) || e))
  }
})()