import { existsSync, readFileSync } from 'node:fs'

const base = new URL('./node_modules/', import.meta.url)
const paths = [
  '@ikenxuan/amagi',
  '@ikenxuan/amagi/package.json',
  '@ikenxuan/amagi/node_modules/axios',
  '@ikenxuan/amagi/node_modules/axios/index.js',
  'axios',
  'axios/index.js',
  '@ikenxuan/watermark',
  '@ikenxuan/watermark/package.json',
]
for (const p of paths) {
  console.log((existsSync(new URL(p, base)) ? 'OK  ' : 'MISS') + '  ' + p)
}
try {
  const pkg = JSON.parse(readFileSync(new URL('@ikenxuan/amagi/package.json', base), 'utf8'))
  console.log('amagi deps:', JSON.stringify(pkg.dependencies))
} catch (e) {
  console.log('amagi deps read err:', e.message)
}