import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] || 'dist-standalone')
const name = process.argv[3] || 'InkPort.html'
const index = join(dir, 'index.html')
let html = await readFile(index, 'utf8')

for (const match of [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const src = match[1]
  if (!src) continue
  const js = await readFile(join(dir, src.replace(/^\.?\//, '')), 'utf8')
  html = html.replace(match[0], `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`)
}

for (const match of [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)]) {
  const href = /href="([^"]+)"/.exec(match[0])?.[1]
  if (!href) continue
  const css = await readFile(join(dir, href.replace(/^\.?\//, '')), 'utf8')
  html = html.replace(match[0], `<style>${css}</style>`)
}

html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '')

const output = join(dir, name)
await writeFile(output, html)
if (name === 'InkPort.html') await writeFile(resolve(dir, '..', name), html)
console.log(`single file: ${output} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`)
