try {
  const mod = await import('@ikenxuan/watermark')
  console.log('dynamic import OK, has embedWatermarkToPngBytes:', typeof mod.embedWatermarkToPngBytes)
} catch (e) {
  console.log('dynamic import ERR:', e.message)
}