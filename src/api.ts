import { baseName, extOf, kindOf, type Kind } from './format'
import { deferred } from './deferred'

export type Entry = {
  name: string
  path: string
  size: number
  updatedAt: number
  dir: boolean
  kind: Kind
  format: string
  thumbnail?: string
}

export type Device = {
  host: string
  id: string
  model: string
  nickname: string
  storageTotal: string
  storageUsed: string
}

export type Book = {
  path: string
  name: string
  title: string
  author: string
  coverPath: string
  format: string
  size: number
  progress: number
  updatedAt: number
}

export type Page<T> = { items: T[]; count: number; fileCount?: number; folderCount?: number }

export type MediaType = 'Recent' | 'Document' | 'Image' | 'Music' | 'Video' | 'Download'

export type MediaListOptions = {
  mediaType: MediaType
  offset?: number
  limit?: number
  search?: string
  endTime?: number
}

export type StorageListOptions = {
  dir: string
  offset?: number
  limit?: number
  search?: string
  sortBy?: string
  sortOrder?: 'Asc' | 'Desc'
}

export type FileUrlOptions = { download?: boolean; stream?: boolean }
export type ClientMode = 'proxy' | 'direct' | 'embedded'

export interface BooxClient {
  host: string
  mode: ClientMode
  device(): Promise<Device>
  ping(): Promise<boolean>
  mediaList(options: MediaListOptions): Promise<Page<Entry>>
  storageList(options: StorageListOptions): Promise<Page<Entry>>
  library(): Promise<Book[]>
  rename(file: string, name: string): Promise<void>
  deleteFile(path: string): Promise<void>
  deleteFolder(parent: string, path: string): Promise<void>
  createFolder(parent: string, name: string): Promise<void>
  upload(dir: string, file: File, onProgress: (loaded: number, total: number) => void): Promise<void>
  fileUrl(path: string, v?: string | number, options?: FileUrlOptions): string
  thumbUrl(path: string, v?: string | number, width?: number): string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseDate(value: unknown): number {
  const raw = text(value)
  if (!raw) return 0
  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw
  const time = Date.parse(normalized)
  return Number.isNaN(time) ? 0 : time
}

function parseEntry(value: unknown): Entry | null {
  const raw = record(value)
  if (!raw) return null
  const name = text(raw.name)
  const path = text(raw.path)
  if (!name || !path) return null
  const dir = raw.dir === true
  const format = extOf(name)
  return {
    name,
    path,
    dir,
    size: num(raw.size),
    updatedAt: num(raw.updatedAt),
    kind: kindOf(name, dir),
    format: format ? format.toUpperCase() : '',
    thumbnail: text(raw.thumbnail) || undefined,
  }
}

function parseBook(value: unknown): Book | null {
  const raw = record(value)
  if (!raw) return null
  const meta = record(raw.metadata) ?? {}
  const path = text(meta.nativeAbsolutePath) || text(meta._id)
  if (!path) return null
  const name = text(meta.name) || baseName(path)
  const authorList = Array.isArray(meta.authorList) ? meta.authorList : []
  const author = authorList
    .map((item) => (typeof item === 'string' ? item : text(record(item)?.name)))
    .filter(Boolean)
    .join(', ')
  return {
    path,
    name,
    title: text(meta.title) || name.replace(/\.[^.]+$/, ''),
    author,
    coverPath: text(raw.coverPath).replace(/\.Middle\.png$/i, '.Large.png'),
    format: (text(meta.type) || extOf(path)).toUpperCase(),
    size: num(meta.size),
    progress: num(raw.progressPercent) || num(meta.progressPercent),
    updatedAt: parseDate(meta.lastModified) || parseDate(meta.updatedAt) || parseDate(meta.createdAt),
  }
}

function pageOf<T>(response: Record<string, unknown>, parse: (value: unknown) => T | null): Page<T> {
  const data = record(response.data) ?? {}
  const list = Array.isArray(data.list) ? data.list : []
  return {
    items: list.map(parse).filter((item): item is T => item !== null),
    count: num(data.count),
    fileCount: num(data.fileCount),
    folderCount: num(data.folderCount),
  }
}

export function createClient(host: string, mode: ClientMode = 'proxy'): BooxClient {
  const origin = mode === 'embedded' ? location.origin : `http://${host}`

  async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(path, { cache: 'no-store', ...init, headers: { accept: 'application/json', ...(init?.headers || {}) } })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(detail || `${res.status} ${res.statusText}`)
    }
    const parsed: unknown = await res.json()
    const body = record(parsed)
    if (!body) throw new Error('设备返回了无法解析的响应')
    if (body.code !== undefined && body.code !== 0) throw new Error(text(body.message) || '设备操作失败')
    return body
  }

  function apiUrl(path: string, params: Record<string, string> = {}): string {
    if (mode !== 'proxy') {
      const search = new URLSearchParams(params)
      const query = search.toString()
      return `${origin}${path}${query ? `?${query}` : ''}`
    }
    const search = new URLSearchParams({ host, ...params })
    return `/d${path}?${search}`
  }

  return {
    host,
    mode,

    async device(): Promise<Device> {
      const body = await requestJson(apiUrl('/api/device'))
      return {
        host,
        id: text(body.id),
        model: text(body.model),
        nickname: text(body.nickname) || text(body.model),
        storageTotal: text(body.storageTotal),
        storageUsed: text(body.storageUsed),
      }
    },

    async ping(): Promise<boolean> {
      const res = await fetch(apiUrl('/api/ping'), { cache: 'no-store' })
      return res.ok && (await res.text()).trim() === 'ok'
    },

    async mediaList(options: {
      mediaType: MediaType
      offset?: number
      limit?: number
      search?: string
      endTime?: number
    }): Promise<Page<Entry>> {
      const args = {
        mediaType: options.mediaType,
        sortBy: 'CreationTime',
        sortOrder: 'Desc',
        limit: options.limit ?? 60,
        offset: options.offset ?? 0,
        refresh: true,
        ...(options.search ? { search: options.search } : {}),
        ...(options.endTime ? { endTime: options.endTime } : {}),
      }
      const url = apiUrl('/api/media/list', { args: JSON.stringify(args) })
      return pageOf(await requestJson(url), parseEntry)
    },

    async storageList(options: {
      dir: string
      offset?: number
      limit?: number
      search?: string
      sortBy?: string
      sortOrder?: 'Asc' | 'Desc'
    }): Promise<Page<Entry>> {
      const args = {
        dir: options.dir,
        sortBy: options.sortBy ?? 'Name',
        sortOrder: options.sortOrder ?? 'Asc',
        limit: options.limit ?? 200,
        offset: options.offset ?? 0,
        refresh: true,
        ...(options.search ? { search: options.search } : {}),
      }
      const url = apiUrl('/api/storage', { args: JSON.stringify(args) })
      return pageOf(await requestJson(url), parseEntry)
    },

    async library(): Promise<Book[]> {
      const body = await requestJson(apiUrl('/api/library', { limit: '1000', offset: '0' }))
      const list = Array.isArray(body.visibleBookList) ? body.visibleBookList : []
      return list.map(parseBook).filter((book): book is Book => book !== null)
    },

    async rename(file: string, name: string): Promise<void> {
      await requestJson(apiUrl('/api/storage/rename'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, name }),
      })
    },

    async deleteFile(path: string): Promise<void> {
      await requestJson(apiUrl('/api/storage/delete', { args: path }), { method: 'DELETE' })
    },

    async deleteFolder(parent: string, path: string): Promise<void> {
      await requestJson(apiUrl('/api/storage/directory/delete'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          selectedMap: { [parent]: { count: 0, selectedAllMode: false, selectedList: [path] } },
        }),
      })
    },

    async createFolder(parent: string, name: string): Promise<void> {
      await requestJson(apiUrl('/api/storage/directory'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parent, name }),
      })
    },

    upload(dir: string, file: File, onProgress: (loaded: number, total: number) => void): Promise<void> {
      const { promise, resolve, reject } = deferred<void>()
      const xhr = new XMLHttpRequest()
      xhr.open('POST', mode !== 'proxy' ? `${origin}/api/storage/upload` : '/d/upload')
      xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total)
      xhr.onerror = () => reject(new Error('上传失败'))
      xhr.onload = () => {
        try {
          const body = record(JSON.parse(xhr.responseText) as unknown)
          if (!body || (body.code !== undefined && body.code !== 0) || body.successful === false) {
            reject(new Error(text(body?.message) || `上传失败 (${xhr.status})`))
            return
          }
          resolve()
        } catch {
          reject(new Error(`上传失败 (${xhr.status})`))
        }
      }
      const form = new FormData()
      form.append('dir', dir)
      form.append('file', file)
      xhr.send(form)
      return promise
    },

    fileUrl(path: string, v?: string | number, options: FileUrlOptions = {}): string {
      if (mode !== 'proxy') {
        return `${origin}/api/storage/file?args=${encodeURIComponent(path)}&sender=boox-desk`
      }
      const params = new URLSearchParams({ host, path })
      if (v !== undefined && v !== '') params.set('v', String(v))
      if (options.download) params.set('download', '1')
      if (options.stream) params.set('stream', '1')
      return `/d/file?${params}`
    },

    thumbUrl(path: string, v?: string | number, width = 480): string {
      if (mode !== 'proxy') {
        return `${origin}/api/storage/thumbnail?args=${encodeURIComponent(path)}`
      }
      const params = new URLSearchParams({ host, path, w: String(width) })
      if (v !== undefined && v !== '') params.set('v', String(v))
      return `/d/thumb?${params}`
    },
  }
}

