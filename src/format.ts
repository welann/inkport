export type Kind = 'image' | 'pdf' | 'book' | 'video' | 'audio' | 'text' | 'archive' | 'app' | 'folder' | 'file'

const KIND_BY_EXT: Record<string, Kind> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', bmp: 'image',
  tif: 'image', tiff: 'image', avif: 'image', heic: 'image', heif: 'image', svg: 'image',
  pdf: 'pdf',
  epub: 'book', azw3: 'book', mobi: 'book', fb2: 'book', cbz: 'book', cbr: 'book', djvu: 'book',
  mp4: 'video', mkv: 'video', webm: 'video', mov: 'video', avi: 'video', m4v: 'video', mpg: 'video', mpeg: 'video',
  mp3: 'audio', flac: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', aac: 'audio',
  txt: 'text', md: 'text', markdown: 'text', json: 'text', csv: 'text', log: 'text', yaml: 'text',
  yml: 'text', toml: 'text', xml: 'text', html: 'text', css: 'text', js: 'text', ts: 'text',
  zip: 'archive', '7z': 'archive', rar: 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive',
  apk: 'app',
}

export const TEXT_EXT: Record<string, true> = {
  txt: true, md: true, markdown: true, json: true, csv: true, log: true, yaml: true, yml: true,
  toml: true, xml: true, html: true, css: true, js: true, ts: true, srt: true, ini: true, conf: true,
}

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    if (c === '"') return '&quot;'
    return '&#39;'
  })
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function kindOf(name: string, dir = false): Kind {
  if (dir) return 'folder'
  return KIND_BY_EXT[extOf(name)] || 'file'
}

export function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

export function crumbsOf(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  const result = [{ label: '内部存储', path: '/storage/emulated/0' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    if (current === '/storage' || current === '/storage/emulated' || current === '/storage/emulated/0') continue
    result.push({ label: part, path: current })
  }
  return result
}

export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const shortDate = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const longDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export function fmtDate(ms: number): string {
  if (!ms) return '—'
  return shortDate.format(new Date(ms))
}

export function fmtDateFull(ms: number): string {
  if (!ms) return '—'
  return longDate.format(new Date(ms))
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const ICONS: Record<string, string> = {
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h7.5A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a2 2 0 0 1-2-2z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 4.5-4.5L13 17l3-3 4 4"/>',
  pdf: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h4"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15M8 7h8M8 11h6"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="m10 9 5 3-5 3z"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  text: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 11h6M9 15h6M9 19h4"/>',
  archive: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v6M10 7h4M10 13h4v4h-4z"/>',
  app: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 20V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/>',
  trash: '<path d="M4 7h16M10 4h4l1 3H9z"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v7h-7"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5H5V6h5"/>',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  folderPlus: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h7.5A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 9v5M12 17h.01"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
}

export function icon(name: string, size = 20): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`
}

export function iconFor(kind: Kind, size = 20): string {
  return icon(kind, size)
}
