const { xiaohongshuFetcher } = require('/root/TRSS_AllBot/TRSS-Yunzai/plugins/kkkkkk-10086/node_modules/@ikenxuan/amagi/dist/default/index.cjs')

;(async () => {
  // 1) 抓游客 a1
  let a1 = ''
  try {
    const res = await fetch('https://www.xiaohongshu.com/', {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' }
    })
    const raw = String(res.headers.get('set-cookie') || '')
    const m = raw.match(/(?:^|;\s*)a1=([^;]+)/i)
    a1 = m ? m[1] : ''
    console.log('A1_GOT=' + (a1 ? a1.slice(0, 12) + '…' : 'NO_A1') + ' status=' + res.status + ' sc0=' + (raw ? 'yes' : 'no'))
    console.log('SC_HEADERS=' + raw.split(';').slice(0, 1).join(','))
  } catch (e) { console.log('A1_ERR=' + (e.message || e)) }

  if (!a1) { console.log('ABORT no a1'); return }
  const cookie = 'a1=' + a1

  // 2) 用该 cookie 尝试拉取笔记
  try {
    const r = await xiaohongshuFetcher.fetchNoteDetail({
      note_id: '6a682a42000000000100f695',
      xsec_token: 'ABwYsMMF84fFsVnXRN15-UvY1fvQAybactoCIriOMFJKM'
    }, cookie)
    const t = JSON.stringify(r)
    console.log('OK_LEN=' + t.length)
    console.log('OK_HEAD=' + t.slice(0, 1800))
  } catch (e) {
    console.log('FETCH_ERR=' + (e && (e.stack || e.message)))
  }
})()