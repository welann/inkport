import * as http from 'node:http'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..')
try {
  process.loadEnvFile(join(ROOT, '.env'))
} catch {
  // .env is optional
}
const PORT = Number(process.env.PORT || 8787)
const BIND = process.env.BIND || '127.0.0.1'
const DEFAULT_HOST = process.env.BOOX_HOST || 'boox.local:8085'
const DIST = join(ROOT, 'dist')
const CACHE = process.env.BOOX_CACHE ? resolve(process.env.BOOX_CACHE) : join(ROOT, '.cache')
const FILE_CACHE = join(CACHE, 'files')
const THUMB_CACHE = join(CACHE, 'thumbs')

// Static extension table: membership is fixed at author time.
const IMAGE_EXT: Record<string, true> = {
  jpg: true, jpeg: true, png: true, webp: true, gif: true,
  bmp: true, tiff: true, tif: true, avif: true, heic: true, heif: true,
}

const MEDIA_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  zip: 'application/zip',
  svg: 'image/svg+xml',
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

type Ctx = { host: string; url: URL }
type Range = { start: number; end: number }

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function fail(res: http.ServerResponse, status: number, message: string) {
  sendJson(res, status, { error: message })
}

function sanitizeHost(raw: string | null | undefined): string {
  const value = (raw || DEFAULT_HOST).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!value || value.length > 255 || !/^[a-zA-Z0-9._\-:[\]]+$/.test(value)) {
    throw new Error('invalid device host')
  }
  return value
}

function upstreamRequest(host: string, path: string, method: string, headers: http.OutgoingHttpHeaders, body?: Readable) {
  return new Promise<http.IncomingMessage>((resolvePromise, reject) => {
    const req = http.request(new URL(path, `http://${host}`), { method, headers, timeout: 60_000 }, (res) => resolvePromise(res))
    req.on('timeout', () => req.destroy(new Error('device timeout')))
    req.on('error', reject)
    if (body) body.pipe(req)
    else req.end()
  })
}

function copyHeaders(res: http.ServerResponse, headers: http.IncomingHttpHeaders, drop: string[] = []) {
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || drop.includes(key.toLowerCase())) continue
    res.setHeader(key, value)
  }
}

async function proxyApi(req: http.IncomingMessage, res: http.ServerResponse, host: string, url: URL) {
  const headers: http.OutgoingHttpHeaders = {}
  for (const key of ['content-type', 'accept', 'range']) {
    const value = req.headers[key]
    if (typeof value === 'string') headers[key] = value
  }
  const params = new URLSearchParams(url.search)
  params.delete('host')
  const path = url.pathname.slice(2) + (params.toString() ? `?${params}` : '')
  const upstream = await upstreamRequest(host, path, req.method || 'GET', headers, req)
  res.statusCode = upstream.statusCode || 502
  copyHeaders(res, upstream.headers, ['connection', 'transfer-encoding', 'keep-alive', 'content-disposition'])
  res.setHeader('cache-control', 'no-store')
  upstream.pipe(res)
}

function fileKey(host: string, path: string): string {
  return createHash('sha1').update(`${host}\0${path}`).digest('hex')
}

async function readMeta(path: string): Promise<{ v: string | null; size: number } | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as { v: string | null; size: number }
  } catch {
    return null
  }
}

const inflight = new Map<string, Promise<void>>()

async function downloadToCache(host: string, path: string, binPath: string, metaPath: string, v: string | null): Promise<void> {
  const existing = inflight.get(binPath)
  if (existing) return existing
  const task = (async () => {
    const upstream = await upstreamRequest(host, `/api/storage/file?args=${encodeURIComponent(path)}&sender=boox-desk`, 'GET', {})
    if (upstream.statusCode !== 200) throw new Error(`device returned ${upstream.statusCode}`)
    const tmp = `${binPath}.${process.pid}.${Date.now()}.part`
    const out = createWriteStream(tmp)
    let size = 0
    upstream.on('data', (chunk: Buffer) => { size += chunk.length })
    await new Promise<void>((resolvePromise, reject) => {
      upstream.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => resolvePromise())
      upstream.pipe(out)
    })
    await rename(tmp, binPath)
    await writeFile(metaPath, JSON.stringify({ v, size }))
  })()
  inflight.set(binPath, task)
  try {
    await task
  } finally {
    inflight.delete(binPath)
  }
}

function parseRange(header: string | undefined, size: number): Range | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  let start = match[1] === '' ? Number.NaN : Number(match[1])
  let end = match[2] === '' ? Number.NaN : Number(match[2])
  if (Number.isNaN(start)) {
    start = Math.max(0, size - (Number.isNaN(end) ? 0 : end))
    end = size - 1
  } else if (Number.isNaN(end)) {
    end = size - 1
  }
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

function contentTypeFor(path: string): string {
  const ext = extname(path).slice(1).toLowerCase()
  if (IMAGE_EXT[ext]) return `image/${ext === 'jpg' ? 'jpeg' : ext === 'tif' ? 'tiff' : ext}`
  return MEDIA_MIME[ext] || 'application/octet-stream'
}

async function serveCachedFile(req: http.IncomingMessage, res: http.ServerResponse, binPath: string, name: string, inline: boolean, contentType: string) {
  const info = await stat(binPath)
  const range = parseRange(req.headers.range, info.size)
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`
  const headers: http.OutgoingHttpHeaders = {
    'content-type': contentType || 'application/octet-stream',
    'content-disposition': disposition,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
      'content-length': range.end - range.start + 1,
    })
    createReadStream(binPath, { start: range.start, end: range.end }).pipe(res)
  } else {
    res.writeHead(200, { ...headers, 'content-length': info.size })
    createReadStream(binPath).pipe(res)
  }
}

async function handleFile(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx) {
  const path = ctx.url.searchParams.get('path') || ''
  if (!path.startsWith('/storage/')) return fail(res, 400, 'invalid path')
  const v = ctx.url.searchParams.get('v')
  const name = path.split('/').pop() || 'file'
  const inline = ctx.url.searchParams.get('download') !== '1'
  const key = fileKey(ctx.host, path)
  const binPath = join(FILE_CACHE, `${key}.bin`)
  const metaPath = join(FILE_CACHE, `${key}.json`)
  const meta = await readMeta(metaPath)
  const cacheValid = meta !== null && (!v || meta.v === v) && existsSync(binPath)

  if (cacheValid) {
    return serveCachedFile(req, res, binPath, name, inline, contentTypeFor(path))
  }

  // PDF/video viewers rely on byte ranges; those need a complete local copy.
  // `stream=1` opts large media out of caching so playback starts immediately.
  if (req.headers.range && ctx.url.searchParams.get('stream') !== '1') {
    try {
      if (meta) await unlink(binPath).catch(() => {})
      await downloadToCache(ctx.host, path, binPath, metaPath, v)
      return serveCachedFile(req, res, binPath, name, inline, contentTypeFor(path))
    } catch {
      // Device refused the copy; fall back to a plain stream below.
    }
  }

  const upstream = await upstreamRequest(
    ctx.host,
    `/api/storage/file?args=${encodeURIComponent(path)}&sender=boox-desk`,
    'GET',
    {},
  )
  if (upstream.statusCode !== 200) {
    res.statusCode = upstream.statusCode || 502
    upstream.pipe(res)
    return
  }

  const headers: http.OutgoingHttpHeaders = {
    'content-type': upstream.headers['content-type'] || contentTypeFor(path),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-cache',
  }
  if (upstream.headers['content-length']) headers['content-length'] = upstream.headers['content-length']
  res.writeHead(200, headers)

  const tmp = `${binPath}.${process.pid}.${Date.now()}.part`
  const out = createWriteStream(tmp)
  let size = 0
  let aborted = false

  upstream.on('data', (chunk: Buffer) => { size += chunk.length })
  res.on('close', () => {
    if (res.writableFinished) return
    aborted = true
    upstream.destroy()
    out.destroy()
    unlink(tmp).catch(() => {})
  })
  out.on('finish', () => {
    if (aborted) return
    rename(tmp, binPath)
      .then(() => writeFile(metaPath, JSON.stringify({ v, size })))
      .catch(() => {})
  })
  upstream.on('error', () => {
    out.destroy()
    unlink(tmp).catch(() => {})
    res.destroy()
  })
  upstream.pipe(out, { end: false })
  upstream.on('end', () => out.end())
  upstream.pipe(res)
}

async function handleThumb(res: http.ServerResponse, ctx: Ctx) {
  const path = ctx.url.searchParams.get('path') || ''
  if (!path.startsWith('/storage/')) return fail(res, 400, 'invalid path')
  const w = Math.min(1600, Math.max(32, Number(ctx.url.searchParams.get('w')) || 480))
  const v = ctx.url.searchParams.get('v') || ''
  const key = createHash('sha1').update(`${ctx.host}\0${path}\0${w}\0${v}`).digest('hex')
  const cachePath = join(THUMB_CACHE, `${key}.webp`)

  if (existsSync(cachePath)) {
    res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=31536000, immutable' })
    return createReadStream(cachePath).pipe(res)
  }

  let task = inflight.get(cachePath)
  if (!task) {
    task = (async () => {
      const ext = extname(path).slice(1).toLowerCase()
      if (IMAGE_EXT[ext]) {
        const upstream = await upstreamRequest(ctx.host, `/api/storage/file?args=${encodeURIComponent(path)}&sender=boox-desk`, 'GET', {})
        if (upstream.statusCode !== 200) throw new Error(`device returned ${upstream.statusCode}`)
        const chunks: Buffer[] = []
        for await (const chunk of upstream) chunks.push(Buffer.from(chunk))
        const out = await sharp(Buffer.concat(chunks), { failOn: 'none' })
          .rotate()
          .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72 })
          .toBuffer()
        const tmp = `${cachePath}.${process.pid}.${Date.now()}.part`
        await writeFile(tmp, out)
        await rename(tmp, cachePath)
        return
      }
      const upstream = await upstreamRequest(ctx.host, `/api/storage/thumbnail?args=${encodeURIComponent(path)}`, 'GET', {})
      if (upstream.statusCode !== 200) throw new Error(`device returned ${upstream.statusCode}`)
      const chunks: Buffer[] = []
      for await (const chunk of upstream) chunks.push(Buffer.from(chunk))
      const out = await sharp(Buffer.concat(chunks), { failOn: 'none' })
        .rotate()
        .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer()
      const tmp = `${cachePath}.${process.pid}.${Date.now()}.part`
      await writeFile(tmp, out)
      await rename(tmp, cachePath)
    })()
    inflight.set(cachePath, task)
    task.finally(() => inflight.delete(cachePath)).catch(() => {})
  }

  try {
    await task
    res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=31536000, immutable' })
    createReadStream(cachePath).pipe(res)
  } catch {
    fail(res, 404, 'thumbnail unavailable')
  }
}

async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, host: string) {
  const headers: http.OutgoingHttpHeaders = {}
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length']
  const upstream = await upstreamRequest(host, '/api/storage/upload', 'POST', headers, req)
  res.statusCode = upstream.statusCode || 502
  copyHeaders(res, upstream.headers, ['connection', 'transfer-encoding', 'keep-alive'])
  upstream.pipe(res)
}

function localSubnets(): string[] {
  const result: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      const parts = net.address.split('.')
      if (parts.length === 4) result.push(parts.slice(0, 3).join('.'))
    }
  }
  return [...new Set(result)]
}

async function probeHost(ip: string): Promise<{ host: string; model?: string; nickname?: string } | null> {
  try {
    const ping = await fetch(`http://${ip}:8085/api/ping`, { signal: AbortSignal.timeout(600) })
    if (!ping.ok) return null
    const device = await fetch(`http://${ip}:8085/api/device`, { signal: AbortSignal.timeout(800) }).then((r) => r.json()) as { model?: string; nickname?: string }
    return { host: `${ip}:8085`, model: device.model, nickname: device.nickname }
  } catch {
    return null
  }
}

async function discover(res: http.ServerResponse) {
  const found = new Map<string, { host: string; model?: string; nickname?: string }>()
  const candidates: string[] = []
  for (const subnet of localSubnets()) {
    for (let i = 1; i <= 254 && candidates.length < 1024; i++) candidates.push(`${subnet}.${i}`)
  }
  const configuredIp = DEFAULT_HOST.split(':')[0] ?? DEFAULT_HOST
  if (!candidates.includes(configuredIp)) candidates.unshift(configuredIp)

  let cursor = 0
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (cursor < candidates.length) {
      const ip = candidates[cursor]
      cursor += 1
      if (!ip) break
      if (found.has(ip)) continue
      const device = await probeHost(ip)
      if (device) found.set(ip, device)
    }
  }))
  sendJson(res, 200, [...found.values()].sort((a, b) => a.host.localeCompare(b.host)))
}

async function serveStatic(res: http.ServerResponse, pathname: string) {
  if (!existsSync(DIST)) return fail(res, 503, 'UI not built. Run `pnpm build` first.')
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  let file = resolve(DIST, `.${rel}`)
  if (!file.startsWith(DIST)) return fail(res, 403, 'forbidden')
  if (!existsSync(file) || (await stat(file)).isDirectory()) {
    if (extname(rel)) return fail(res, 404, 'not found')
    file = join(DIST, 'index.html')
  }
  const ext = extname(file).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  })
  createReadStream(file).pipe(res)
}

await mkdir(FILE_CACHE, { recursive: true })
await mkdir(THUMB_CACHE, { recursive: true })

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    if (pathname === '/d/health') return sendJson(res, 200, { ok: true, defaultHost: DEFAULT_HOST, cache: CACHE })
    if (pathname === '/d/discover') return await discover(res)
    if (pathname === '/d/upload') return await handleUpload(req, res, sanitizeHost(url.searchParams.get('host')))

    if (pathname === '/d/file' || pathname === '/d/thumb') {
      const ctx = { host: sanitizeHost(url.searchParams.get('host')), url }
      return pathname === '/d/file' ? await handleFile(req, res, ctx) : await handleThumb(res, ctx)
    }

    if (pathname === '/d/ping' || pathname === '/d/device') {
      const host = sanitizeHost(url.searchParams.get('host'))
      const upstream = await upstreamRequest(host, `/api/${pathname.slice(3)}`, 'GET', {})
      res.statusCode = upstream.statusCode || 502
      copyHeaders(res, upstream.headers, ['connection', 'transfer-encoding', 'keep-alive'])
      upstream.pipe(res)
      return
    }

    if (pathname.startsWith('/d/api/')) {
      const host = sanitizeHost(url.searchParams.get('host'))
      return await proxyApi(req, res, host, url)
    }

    return await serveStatic(res, pathname)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected error'
    if (!res.headersSent) fail(res, 502, message)
    else res.destroy()
  }
})

server.listen(PORT, BIND, () => {
  console.log(`墨港 · InkPort → http://${BIND}:${PORT}  (device ${DEFAULT_HOST}, cache ${CACHE})`)
})
