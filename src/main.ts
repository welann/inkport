import './styles.css'
import { createClient, type Book, type BooxClient, type Device, type Entry } from './api'
import { askConfirm, askText } from './dialog'
import { clamp, crumbsOf, esc, fmtDate, fmtSize, icon, iconFor, parentDir } from './format'
import { isLightboxOpen, openLightbox } from './lightbox'
import { closePreview, openBookPreview, openPreview } from './preview'
import { EMBEDDED, STANDALONE } from './mode'

type Tab = 'recent' | 'images' | 'books' | 'files'
type ViewMode = 'grid' | 'list'
type Theme = 'auto' | 'light' | 'dark'
type SortBy = 'Name' | 'Size' | 'CreationTime' | 'ModifiedTime'
type SortOrder = 'Asc' | 'Desc'

type UploadTask = {
  id: number
  name: string
  size: number
  loaded: number
  status: 'queued' | 'uploading' | 'done' | 'error'
  error?: string
  file: File
}

type FilesState = {
  dir: string
  items: Entry[]
  total: number
  fileCount: number
  folderCount: number
  loaded: boolean
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'recent', label: '最近' },
  { id: 'images', label: '图片' },
  { id: 'books', label: '书库' },
  { id: 'files', label: '文件' },
]

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'Name:Asc', label: '名称 A→Z' },
  { value: 'Name:Desc', label: '名称 Z→A' },
  { value: 'CreationTime:Desc', label: '最新优先' },
  { value: 'CreationTime:Asc', label: '最早优先' },
  { value: 'Size:Desc', label: '最大优先' },
  { value: 'Size:Asc', label: '最小优先' },
]

const storedView = localStorage.getItem('boox.view')
const storedTab = localStorage.getItem('boox.tab')
const storedTheme = localStorage.getItem('boox.theme')

const state = {
  host: localStorage.getItem('boox.host') || '',
  tab: (TABS.some((tab) => tab.id === storedTab) ? storedTab : 'recent') as Tab,
  view: (storedView === 'list' ? 'list' : 'grid') as ViewMode,
  theme: (storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'auto') as Theme,
  sort: localStorage.getItem('boox.sort') || 'Name:Asc',
  search: '',
  online: false,
  connecting: false,
  device: null as Device | null,
  error: '',
  loading: false,
  recent: [] as Entry[],
  recentTotal: 0,
  images: [] as Entry[],
  imagesTotal: 0,
  books: [] as Book[],
  booksLoaded: false,
  bookCovers: new Map<string, string>(),
  bookCoversLoaded: false,
  files: { dir: '/storage/emulated/0', items: [], total: 0, fileCount: 0, folderCount: 0, loaded: false } as FilesState,
  uploads: [] as UploadTask[],
}

function clientMode(): 'proxy' | 'direct' | 'embedded' {
  if (EMBEDDED) return 'embedded'
  return STANDALONE ? 'direct' : 'proxy'
}

let client: BooxClient = createClient(state.host || 'boox.local:8085', clientMode())
let uploadSequence = 0
let uploadRunning = false
let uploadFrame = 0
let searchTimer = 0
let recentSeq = 0
let imagesSeq = 0
let booksSeq = 0
let filesSeq = 0
let bookCoversPromise: Promise<void> | null = null

const viewRoot = () => document.getElementById('view')

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setHost(host: string): void {
  state.host = host
  localStorage.setItem('boox.host', host)
  client = createClient(host, clientMode())
}

function applyTheme(): void {
  const resolved = state.theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : state.theme
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.themeMode = state.theme
  const button = document.querySelector<HTMLElement>('[data-action="theme"]')
  if (button) button.innerHTML = icon(resolved === 'dark' ? 'moon' : 'sun', 18)
}

function toast(message: string, tone: 'info' | 'error' | 'success' = 'info'): void {
  const root = document.getElementById('toasts')
  if (!root) return
  const item = document.createElement('div')
  item.className = `toast ${tone}`
  item.textContent = message
  root.append(item)
  window.setTimeout(() => item.classList.add('out'), 2600)
  window.setTimeout(() => item.remove(), 3000)
}

function renderShell(): void {
  const app = document.getElementById('app')
  if (!app) return
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">墨</div>
        <div class="brand-text"><strong>墨港</strong>${STANDALONE ? '<span class="brand-badge">设备版</span>' : ''}</div>
      </div>
      <nav class="tabs" id="tabs" aria-label="视图">
        ${TABS.map((tab) => `<button class="tab" data-action="tab" data-tab="${tab.id}">${tab.label}</button>`).join('')}
      </nav>
      <div class="tools">
        <label class="search">
          <span class="search-icon">${icon('search', 18)}</span>
          <input id="search" type="search" placeholder="搜索文件…" autocomplete="off" spellcheck="false" />
          <kbd>/</kbd>
        </label>
        <button class="icon-btn" data-action="refresh" title="刷新 (R)" aria-label="刷新">${icon('refresh', 18)}</button>
        <button class="icon-btn" id="view-toggle" data-action="toggle-view" title="切换视图 (G)" aria-label="切换视图">${icon('grid', 18)}</button>
        <button class="icon-btn" data-action="theme" title="切换主题" aria-label="切换主题">${icon('sun', 18)}</button>
        <button class="icon-btn" data-action="settings" title="设置" aria-label="设置">${icon('settings', 18)}</button>
      </div>
    </header>
    <div class="statusline" id="statusline"></div>
    <main class="view" id="view"></main>
    <div id="lightbox-root"></div>
    <div id="modal-root"></div>
    <div id="dialog-root"></div>
    <div id="upload-panel"></div>
    <div id="toasts" class="toasts"></div>
    <div class="drop-overlay" id="drop-overlay"><div class="drop-card">${icon('upload', 36)}<strong>松开以上传到设备</strong><span id="drop-target"></span></div></div>
  `
  bindSearch()
  renderTabs()
  renderStatus()
}

function renderTabs(): void {
  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
    const active = tab.dataset.tab === state.tab
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
  })
  const toggle = document.getElementById('view-toggle')
  if (toggle) {
    toggle.style.display = state.tab === 'files' ? '' : 'none'
    toggle.innerHTML = state.view === 'grid' ? icon('grid', 18) : icon('list', 18)
  }
  const search = document.getElementById('search') as HTMLInputElement | null
  if (search) {
    const placeholders: Record<Tab, string> = {
      recent: '搜索最近文件…',
      images: '搜索图片…',
      books: '搜索书库…',
      files: '搜索当前文件夹…',
    }
    search.placeholder = placeholders[state.tab]
  }
}

function renderStatus(): void {
  const line = document.getElementById('statusline')
  if (!line) return
  if (state.connecting) {
    line.innerHTML = `<span class="dot connecting"></span><span>正在连接 ${esc(state.host)}…</span>`
    return
  }
  if (state.online && state.device) {
    const device = state.device
    line.innerHTML = `
      <span class="dot online"></span>
      <span class="status-strong">${esc(device.nickname || device.model)}</span>
      ${device.nickname && device.nickname !== device.model ? `<span class="status-sep">·</span><span>${esc(device.model)}</span>` : ''}
      <span class="status-sep">·</span>
      <span>${esc(device.storageUsed)} / ${esc(device.storageTotal)}</span>
      <span class="status-sep">·</span>
      <span class="mono muted">${esc(device.host)}</span>
      <button class="link-btn" data-action="settings">设置</button>
    `
    return
  }
  line.innerHTML = `
    <span class="dot offline"></span>
    <span>未连接设备</span>
    <span class="status-sep">·</span>
    <span class="mono muted">${esc(state.host)}</span>
    <button class="link-btn" data-action="settings">连接设置</button>
  `
}

async function connect(): Promise<void> {
  state.connecting = true
  state.error = ''
  renderStatus()
  renderView()
  try {
    const [device] = await Promise.all([client.device(), client.ping()])
    state.device = device
    state.online = true
    await loadCurrent(true)
  } catch (error) {
    state.online = false
    state.error = messageOf(error)
  } finally {
    state.connecting = false
    renderStatus()
    renderView()
  }
}

async function loadCurrent(reset: boolean): Promise<void> {
  state.error = ''
  if (state.tab === 'recent') await loadRecent(reset)
  else if (state.tab === 'images') await loadImages(reset)
  else if (state.tab === 'books') await loadBooks()
  else await loadFiles(reset)
}

function setBookCovers(books: Book[]): void {
  const covers = new Map<string, string>()
  for (const book of books) {
    if (book.coverPath) covers.set(book.path, book.coverPath)
  }
  state.bookCovers = covers
  state.bookCoversLoaded = true
}

async function ensureBookCovers(): Promise<void> {
  if (state.bookCoversLoaded) return
  if (!bookCoversPromise) {
    const host = client.host
    bookCoversPromise = client.library()
      .then((books) => {
        if (client.host === host) setBookCovers(books)
      })
      .catch(() => {})
      .finally(() => { bookCoversPromise = null })
  }
  await bookCoversPromise
}

async function loadRecent(reset: boolean): Promise<void> {
  const seq = ++recentSeq
  const search = state.search
  const offset = reset ? 0 : state.recent.length
  state.loading = true
  if (reset) {
    state.recent = []
    state.recentTotal = 0
  }
  renderView()
  try {
    const [page] = await Promise.all([
      client.mediaList({
        mediaType: 'Recent',
        offset,
        limit: 60,
        search: search || undefined,
        endTime: Date.now() - 30 * 24 * 3600 * 1000,
      }),
      ensureBookCovers(),
    ])
    if (seq !== recentSeq) return
    state.recent = reset ? page.items : [...state.recent, ...page.items]
    state.recentTotal = page.count
    state.error = ''
  } catch (error) {
    if (seq !== recentSeq) return
    state.error = messageOf(error)
  } finally {
    if (seq === recentSeq) {
      state.loading = false
      renderView()
    }
  }
}

async function loadImages(reset: boolean): Promise<void> {
  const seq = ++imagesSeq
  const search = state.search
  const offset = reset ? 0 : state.images.length
  state.loading = true
  if (reset) {
    state.images = []
    state.imagesTotal = 0
  }
  renderView()
  try {
    const page = await client.mediaList({
      mediaType: 'Image',
      offset,
      limit: 120,
      search: search || undefined,
    })
    if (seq !== imagesSeq) return
    state.images = reset ? page.items : [...state.images, ...page.items]
    state.imagesTotal = page.count
    state.error = ''
  } catch (error) {
    if (seq !== imagesSeq) return
    state.error = messageOf(error)
  } finally {
    if (seq === imagesSeq) {
      state.loading = false
      renderView()
    }
  }
}

async function loadBooks(): Promise<void> {
  const seq = ++booksSeq
  state.loading = true
  renderView()
  try {
    const books = await client.library()
    if (seq !== booksSeq) return
    state.books = books
    setBookCovers(books)
    state.booksLoaded = true
    state.error = ''
  } catch (error) {
    if (seq !== booksSeq) return
    state.error = messageOf(error)
  } finally {
    if (seq === booksSeq) {
      state.loading = false
      renderView()
    }
  }
}

function parseSort(): { by: SortBy; order: SortOrder } {
  const [by, order] = state.sort.split(':')
  return {
    by: (by === 'Size' || by === 'CreationTime' || by === 'ModifiedTime' ? by : 'Name') as SortBy,
    order: order === 'Desc' ? 'Desc' : 'Asc',
  }
}

async function loadFiles(reset: boolean): Promise<void> {
  const seq = ++filesSeq
  const dir = state.files.dir
  const search = state.search
  const sort = parseSort()
  const offset = reset ? 0 : state.files.items.length
  state.loading = true
  if (reset) {
    state.files.items = []
    state.files.total = 0
  }
  renderView()
  try {
    const [page] = await Promise.all([
      client.storageList({
        dir,
        offset,
        limit: 200,
        search: search || undefined,
        sortBy: sort.by,
        sortOrder: sort.order,
      }),
      ensureBookCovers(),
    ])
    if (seq !== filesSeq) return
    state.files.items = reset ? page.items : [...state.files.items, ...page.items]
    state.files.total = page.count
    state.files.fileCount = page.fileCount || 0
    state.files.folderCount = page.folderCount || 0
    state.files.loaded = true
    state.error = ''
  } catch (error) {
    if (seq !== filesSeq) return
    state.error = messageOf(error)
  } finally {
    if (seq === filesSeq) {
      state.loading = false
      renderView()
    }
  }
}

function renderView(): void {
  const root = viewRoot()
  if (!root) return
  if (!state.host) {
    root.innerHTML = emptyState('monitor', '尚未连接设备', '在设置中填写 Leaf5C 的地址。')
    return
  }
  if (state.connecting) {
    root.innerHTML = `<div class="section-head"><div><h1>连接中…</h1><p class="muted">${esc(state.host)}</p></div></div>${gridSkeleton(8)}`
    return
  }
  if (state.error && !hasContent()) {
    root.innerHTML = `
      <div class="empty error">
        <div class="empty-icon">${icon('alert', 40)}</div>
        <h2>无法连接设备</h2>
        <p>${esc(state.error)}</p>
        <div class="empty-actions">
          <button class="btn primary" data-action="refresh">重试</button>
          <button class="btn ghost" data-action="settings">设置地址</button>
        </div>
      </div>
    `
    return
  }
  root.innerHTML = `
    ${state.error ? `<div class="inline-error">${icon('alert', 16)} ${esc(state.error)}<button class="link-btn" data-action="refresh">重试</button></div>` : ''}
    ${renderCurrentView()}
  `
  observeSentinel()
  hydrateThumbs()
}

function hasContent(): boolean {
  if (state.tab === 'recent') return state.recent.length > 0
  if (state.tab === 'images') return state.images.length > 0
  if (state.tab === 'books') return state.books.length > 0
  return state.files.items.length > 0
}

function renderCurrentView(): string {
  if (state.tab === 'recent') return renderMedia('recent')
  if (state.tab === 'images') return renderMedia('images')
  if (state.tab === 'books') return renderBooks()
  return renderFiles()
}

function renderMedia(kind: 'recent' | 'images'): string {
  const items = kind === 'recent' ? state.recent : state.images
  const total = kind === 'recent' ? state.recentTotal : state.imagesTotal
  const title = kind === 'recent' ? '最近文件' : '图片'
  const subtitle = kind === 'recent' ? '最近 30 天新增或打开的文件' : '设备上的截图与图片'
  if (!items.length && state.loading) {
    return `<div class="section-head"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>${gridSkeleton(12)}`
  }
  if (!items.length) {
    return emptyState('image', state.search ? '没有匹配的文件' : '暂无内容', state.search ? '换个关键词试试。' : subtitle)
  }
  return `
    <div class="section-head">
      <div>
        <h1>${title}</h1>
        <p class="muted">${state.search ? `“${esc(state.search)}” 的搜索结果` : subtitle}</p>
      </div>
      <div class="section-count">${total} 项</div>
    </div>
    <div class="grid">${items.map(entryCard).join('')}</div>
    ${sentinel(items.length < total)}
  `
}

function renderBooks(): string {
  const query = state.search.trim().toLowerCase()
  const books = query
    ? state.books.filter((book) => `${book.title} ${book.author} ${book.name}`.toLowerCase().includes(query))
    : state.books
  if (!state.booksLoaded && state.loading) {
    return `<div class="section-head"><div><h1>书库</h1><p class="muted">设备书库中的电子书</p></div></div>${gridSkeleton(8)}`
  }
  if (!books.length) {
    return emptyState('book', query ? '没有匹配的书籍' : '书库为空', query ? '换个关键词试试。' : '通过上传或设备阅读后，书籍会出现在这里。')
  }
  return `
    <div class="section-head">
      <div>
        <h1>书库</h1>
        <p class="muted">${query ? `“${esc(state.search)}” 的搜索结果` : '来自设备的书库与书架'}</p>
      </div>
      <div class="section-count">${books.length} 本</div>
    </div>
    <div class="book-grid">${books.map(bookCard).join('')}</div>
  `
}

function renderFiles(): string {
  const { dir, items, total, fileCount, folderCount } = state.files
  const crumbs = crumbsOf(dir)
  const sortOptions = SORT_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === state.sort ? 'selected' : ''}>${option.label}</option>`).join('')
  const listing = items.length
    ? (state.view === 'grid' ? `<div class="grid files-grid">${items.map(entryCard).join('')}</div>` : `<div class="file-list">${items.map(fileRow).join('')}</div>`)
    : (state.loading ? gridSkeleton(10) : emptyState('folder', state.search ? '没有匹配的文件' : '文件夹为空', state.search ? '换个关键词试试。' : '拖拽文件到这里即可上传。'))

  return `
    <div class="section-head files-head">
      <div class="files-title">
        <div class="crumbs">
          ${crumbs.map((crumb, index) => index === crumbs.length - 1
            ? `<span class="crumb current">${esc(crumb.label)}</span>`
            : `<button class="crumb" data-action="navigate" data-path="${esc(crumb.path)}">${esc(crumb.label)}</button><span class="crumb-sep">/</span>`).join('')}
        </div>
        <p class="muted">${state.search ? `“${esc(state.search)}” 的搜索结果 · ` : ''}${folderCount} 个文件夹 · ${fileCount} 个文件</p>
      </div>
      <div class="files-actions">
        <button class="btn ghost" data-action="new-folder">${icon('folderPlus', 16)} 新建文件夹</button>
        <button class="btn primary" data-action="upload-pick">${icon('upload', 16)} 上传</button>
        <select id="sort-select" class="select" aria-label="排序">${sortOptions}</select>
      </div>
    </div>
    ${listing}
    ${sentinel(items.length < total)}
  `
}

const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function entryCard(entry: Entry): string {
  const coverPath = state.bookCovers.get(entry.path)
  const thumb = entry.kind === 'image'
    ? client.mode !== 'proxy'
      ? `<img class="thumb-pending" data-thumb="${esc(entry.path)}" data-v="${entry.updatedAt}" src="${TRANSPARENT_PIXEL}" loading="lazy" decoding="async" alt="" />`
      : `<img loading="lazy" decoding="async" src="${esc(client.thumbUrl(entry.path, entry.updatedAt, 520))}" alt="" />`
    : coverPath
      ? `<img loading="lazy" decoding="async" src="${esc(client.thumbUrl(coverPath, entry.updatedAt, 520))}" alt="" />`
      : `<span class="glyph">${iconFor(entry.kind, 42)}</span>`
  return `
    <article class="card" data-action="open" data-path="${esc(entry.path)}" tabindex="0" role="button" aria-label="${esc(entry.name)}">
      <div class="card-thumb kind-${entry.kind}">
        ${thumb}
        ${!entry.dir && entry.format ? `<span class="format">${esc(entry.format)}</span>` : ''}
        <button class="card-menu" data-action="menu" data-path="${esc(entry.path)}" aria-label="更多操作">${icon('more', 16)}</button>
      </div>
      <div class="card-info">
        <span class="card-name" title="${esc(entry.name)}">${esc(entry.name)}</span>
        <span class="card-meta">${entry.dir ? '文件夹' : fmtSize(entry.size)} · ${fmtDate(entry.updatedAt)}</span>
      </div>
    </article>
  `
}

function bookCard(book: Book): string {
  const cover = book.coverPath
    ? `<img loading="lazy" decoding="async" src="${esc(client.thumbUrl(book.coverPath, book.updatedAt, 360))}" alt="" />`
    : `<span class="glyph">${iconFor('book', 46)}</span>`
  return `
    <article class="book-card" data-action="open-book" data-path="${esc(book.path)}" tabindex="0" role="button" aria-label="${esc(book.title)}">
      <div class="book-cover">${cover}</div>
      <div class="book-meta">
        <span class="book-title" title="${esc(book.title)}">${esc(book.title)}</span>
        <span class="book-author">${esc(book.author || '未知作者')}</span>
        <span class="book-progress"><span style="width:${clamp(book.progress, 0, 100)}%"></span></span>
      </div>
    </article>
  `
}

function fileRow(entry: Entry): string {
  return `
    <div class="file-row ${entry.dir ? 'is-dir' : ''}" data-action="open" data-path="${esc(entry.path)}" tabindex="0" role="button">
      <div class="file-name"><span class="file-icon">${iconFor(entry.kind, 18)}</span><span class="ellipsis">${esc(entry.name)}</span></div>
      <div class="file-size">${entry.dir ? '—' : fmtSize(entry.size)}</div>
      <div class="file-date">${fmtDate(entry.updatedAt)}</div>
      <button class="row-menu" data-action="menu" data-path="${esc(entry.path)}" aria-label="更多操作">${icon('more', 18)}</button>
    </div>
  `
}

function gridSkeleton(count: number): string {
  return `<div class="grid">${Array.from({ length: count }, () => '<div class="card skeleton"><div class="card-thumb"></div><div class="card-info"><span class="sk-line"></span><span class="sk-line short"></span></div></div>').join('')}</div>`
}

function sentinel(hasMore: boolean): string {
  if (!hasMore) return '<div class="end-marker">已经到底了</div>'
  return `<div class="sentinel" id="sentinel"><span class="spinner"></span> 加载更多…</div>`
}

function emptyState(iconName: string, title: string, hint: string): string {
  return `
    <div class="empty">
      <div class="empty-icon">${icon(iconName, 42)}</div>
      <h2>${esc(title)}</h2>
      <p>${esc(hint)}</p>
    </div>
  `
}

let sentinelObserver: IntersectionObserver | null = null

function observeSentinel(): void {
  const sentinelEl = document.getElementById('sentinel')
  if (!sentinelEl) return
  if (!sentinelObserver) {
    sentinelObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '500px 0px' })
  }
  sentinelObserver.disconnect()
  sentinelObserver.observe(sentinelEl)
}


const thumbCache = new Map<string, string>()
const thumbQueue: HTMLImageElement[] = []
let thumbObserver: IntersectionObserver | null = null
let thumbRunning = 0

function hydrateThumbs(): void {
  if (client.mode === 'proxy') return
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        thumbObserver?.unobserve(entry.target)
        queueThumb(entry.target as HTMLImageElement)
      }
    }, { rootMargin: '500px 0px' })
  }
  thumbObserver.disconnect()
  document.querySelectorAll<HTMLImageElement>('img[data-thumb]').forEach((img) => thumbObserver?.observe(img))
}

function queueThumb(img: HTMLImageElement): void {
  const path = img.dataset.thumb
  const version = img.dataset.v || ''
  if (!path) return
  const cached = thumbCache.get(`${path}|${version}`)
  if (cached) {
    img.src = cached
    img.classList.remove('thumb-pending')
    return
  }
  thumbQueue.push(img)
  pumpThumbs()
}

function pumpThumbs(): void {
  while (thumbRunning < 3 && thumbQueue.length) {
    const img = thumbQueue.shift()
    if (!img) break
    if (!img.isConnected) continue
    thumbRunning += 1
    void makeThumb(img).finally(() => {
      thumbRunning -= 1
      pumpThumbs()
    })
  }
}

async function makeThumb(img: HTMLImageElement): Promise<void> {
  const path = img.dataset.thumb
  const version = img.dataset.v || ''
  if (!path) return
  const key = `${path}|${version}`
  const cached = thumbCache.get(key)
  if (cached) {
    img.src = cached
    img.classList.remove('thumb-pending')
    return
  }
  try {
    const response = await fetch(client.fileUrl(path, version))
    if (!response.ok) throw new Error(String(response.status))
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, 440 / bitmap.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const thumb = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.72))
    if (!thumb) throw new Error('thumbnail failed')
    const url = URL.createObjectURL(thumb)
    thumbCache.set(key, url)
    img.src = url
    img.classList.remove('thumb-pending')
  } catch {
    img.classList.remove('thumb-pending')
    img.src = client.fileUrl(path, version)
    img.removeAttribute('data-thumb')
  }
}

async function loadMore(): Promise<void> {
  if (state.loading) return
  if (state.tab === 'recent' && state.recent.length < state.recentTotal) await loadRecent(false)
  else if (state.tab === 'images' && state.images.length < state.imagesTotal) await loadImages(false)
  else if (state.tab === 'files' && state.files.items.length < state.files.total) await loadFiles(false)
}

function findEntry(path: string): Entry | null {
  const pools = [state.files.items, state.recent, state.images]
  for (const pool of pools) {
    const found = pool.find((entry) => entry.path === path)
    if (found) return found
  }
  return null
}

function currentImages(): Entry[] {
  if (state.tab === 'files') return state.files.items.filter((entry) => entry.kind === 'image')
  if (state.tab === 'recent') return state.recent.filter((entry) => entry.kind === 'image')
  if (state.tab === 'images') return state.images
  return []
}

function openEntry(entry: Entry): void {
  if (entry.dir) {
    state.tab = 'files'
    localStorage.setItem('boox.tab', 'files')
    state.files.dir = entry.path
    state.search = ''
    syncSearch()
    renderTabs()
    void loadFiles(true)
    return
  }
  if (entry.kind === 'image') {
    const images = currentImages()
    const index = images.findIndex((item) => item.path === entry.path)
    openLightbox(images, Math.max(0, index), {
      url: (image) => client.fileUrl(image.path, image.updatedAt),
      downloadUrl: (image) => client.fileUrl(image.path, image.updatedAt, { download: true }),
      allowRaw: client.mode === 'proxy',
      deleteEntry: deleteEntry,
    })
    return
  }
  void openPreview(entry, client, { deleteEntry })
}

function openBook(book: Book): void {
  void openBookPreview(book, client, { deleteEntry })
}

async function deleteEntry(entry: Entry): Promise<boolean> {
  const confirmed = await askConfirm({
    title: entry.dir ? '删除文件夹' : '删除文件',
    message: `确定要从设备删除 “${entry.name}” 吗？${entry.dir ? '文件夹内的内容也会一并删除。' : ''}此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!confirmed) return false
  try {
    if (entry.dir) await client.deleteFolder(parentDir(entry.path), entry.path)
    else await client.deleteFile(entry.path)
    state.recent = state.recent.filter((item) => item.path !== entry.path)
    state.images = state.images.filter((item) => item.path !== entry.path)
    state.files.items = state.files.items.filter((item) => item.path !== entry.path)
    toast('已删除', 'success')
    if (state.tab === 'files') await loadFiles(true)
    else renderView()
    return true
  } catch (error) {
    toast(messageOf(error), 'error')
    return false
  }
}

async function renameEntry(entry: Entry): Promise<void> {
  const name = await askText({ title: '重命名', label: '新的名称', value: entry.name, confirmText: '重命名' })
  if (!name || name === entry.name) return
  try {
    await client.rename(entry.path, name)
    toast('已重命名', 'success')
    await loadCurrent(true)
  } catch (error) {
    toast(messageOf(error), 'error')
  }
}

async function createFolder(): Promise<void> {
  const name = await askText({ title: '新建文件夹', label: '文件夹名称', confirmText: '创建' })
  if (!name) return
  try {
    await client.createFolder(state.files.dir, name)
    toast('已创建', 'success')
    await loadFiles(true)
  } catch (error) {
    toast(messageOf(error), 'error')
  }
}

function downloadEntry(entry: Entry): void {
  const anchor = document.createElement('a')
  anchor.href = client.fileUrl(entry.path, entry.updatedAt, { download: true })
  anchor.download = entry.name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

let menuElement: HTMLElement | null = null

function closeMenu(): void {
  menuElement?.remove()
  menuElement = null
}

function openMenu(anchor: HTMLElement, entry: Entry): void {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'context-menu'
  const actions: { label: string; danger?: boolean; run: () => void }[] = [
    { label: '打开', run: () => openEntry(entry) },
    ...(entry.dir ? [] : [{ label: '下载', run: () => downloadEntry(entry) }]),
    { label: '重命名', run: () => void renameEntry(entry) },
    { label: '删除', danger: true, run: () => void deleteEntry(entry) },
  ]
  for (const action of actions) {
    const button = document.createElement('button')
    button.className = `menu-item${action.danger ? ' danger' : ''}`
    button.textContent = action.label
    button.addEventListener('click', () => {
      closeMenu()
      action.run()
    })
    menu.append(button)
  }
  document.body.append(menu)
  menuElement = menu
  const rect = anchor.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()
  const left = Math.min(rect.left, window.innerWidth - menuRect.width - 8)
  const top = rect.bottom + menuRect.height + 8 > window.innerHeight ? rect.top - menuRect.height - 6 : rect.bottom + 6
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`
}

function uploadTarget(): string {
  return state.files.dir || '/storage/emulated/0'
}

function renderUploads(): void {
  const root = document.getElementById('upload-panel')
  if (!root) return
  if (!state.uploads.length) {
    root.innerHTML = ''
    return
  }
  const active = state.uploads.filter((task) => task.status === 'uploading' || task.status === 'queued').length
  const items = state.uploads.map((task) => {
    const percent = task.size > 0 ? Math.round((task.loaded / task.size) * 100) : 0
    const status = task.status === 'done' ? '已完成' : task.status === 'error' ? (task.error || '失败') : `${percent}%`
    return `
      <div class="upload-item ${task.status}">
        <div class="upload-line"><span class="upload-name" title="${esc(task.name)}">${esc(task.name)}</span><span class="upload-status">${esc(status)}</span></div>
        <div class="progress"><span style="width:${task.status === 'done' ? 100 : percent}%"></span></div>
      </div>
    `
  }).join('')
  root.innerHTML = `
    <div class="upload-card">
      <header><strong>${active ? `正在上传 ${active} 个文件` : '上传记录'}</strong><button class="icon-btn" data-action="clear-uploads" aria-label="清除">${icon('close', 16)}</button></header>
      <div class="upload-target mono">→ ${esc(uploadTarget())}</div>
      <div class="upload-list">${items}</div>
    </div>
  `
}

function scheduleUploadRender(): void {
  if (uploadFrame) return
  uploadFrame = requestAnimationFrame(() => {
    uploadFrame = 0
    renderUploads()
  })
}

function queueUploads(files: File[]): void {
  if (!files.length) return
  for (const file of files) {
    state.uploads.push({
      id: ++uploadSequence,
      name: file.name,
      size: file.size,
      loaded: 0,
      status: 'queued',
      file,
    })
  }
  renderUploads()
  void processUploads()
}

async function processUploads(): Promise<void> {
  if (uploadRunning) return
  uploadRunning = true
  for (;;) {
    const task = state.uploads.find((item) => item.status === 'queued')
    if (!task) break
    task.status = 'uploading'
    renderUploads()
    try {
      await client.upload(uploadTarget(), task.file, (loaded, total) => {
        task.loaded = loaded
        if (total) task.size = total
        scheduleUploadRender()
      })
      task.status = 'done'
      task.loaded = task.size
    } catch (error) {
      task.status = 'error'
      task.error = messageOf(error)
    }
    renderUploads()
  }
  uploadRunning = false
  state.bookCoversLoaded = false
  bookCoversPromise = null
  toast('上传完成', 'success')
  window.setTimeout(() => {
    if (state.uploads.some((task) => task.status === 'uploading' || task.status === 'queued')) return
    if (state.uploads.every((task) => task.status === 'done')) {
      state.uploads = []
      renderUploads()
    }
  }, 6000)
  if (state.tab === 'files') await loadFiles(true)
  else if (state.tab !== 'books') await loadCurrent(true)
}

function pickFiles(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.addEventListener('change', () => {
    queueUploads(Array.from(input.files || []))
  })
  input.click()
}

function bindSearch(): void {
  const input = document.getElementById('search') as HTMLInputElement | null
  if (!input) return
  input.value = state.search
  input.addEventListener('input', () => {
    state.search = input.value.trim()
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      if (state.tab === 'books') renderView()
      else void loadCurrent(true)
    }, 280)
  })
}

function syncSearch(): void {
  const input = document.getElementById('search') as HTMLInputElement | null
  if (input) input.value = state.search
}

function setTab(tab: Tab): void {
  if (state.tab === tab) return
  state.tab = tab
  localStorage.setItem('boox.tab', tab)
  state.search = ''
  syncSearch()
  renderTabs()
  window.scrollTo({ top: 0 })
  const needsLoad = tab === 'recent' ? state.recent.length === 0
    : tab === 'images' ? state.images.length === 0
    : tab === 'books' ? !state.booksLoaded
    : !state.files.loaded
  if (needsLoad) void loadCurrent(true)
  else renderView()
}

function toggleView(): void {
  state.view = state.view === 'grid' ? 'list' : 'grid'
  localStorage.setItem('boox.view', state.view)
  renderTabs()
  renderView()
}

function cycleTheme(): void {
  state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto'
  localStorage.setItem('boox.theme', state.theme)
  applyTheme()
  toast(`主题：${state.theme === 'auto' ? '跟随系统' : state.theme === 'light' ? '浅色' : '深色'}`)
}

function openSettings(): void {
  const root = document.getElementById('modal-root')
  if (!root) return
  root.innerHTML = `
    <div class="modal-backdrop"><div class="modal settings-modal" data-stop>
      <header class="dialog-head">
        <h2>连接设置</h2>
        <button class="icon-btn" data-action="close-settings" aria-label="关闭">${icon('close', 20)}</button>
      </header>
      <div class="dialog-body">
        ${EMBEDDED
          ? '<p class="muted small">当前页面由设备上的 BooxDrop 提供，API 同源访问，无需填写地址。</p>'
          : `<label class="field"><span>设备地址</span><input id="host-input" value="${esc(state.host)}" spellcheck="false" autocomplete="off" placeholder="boox.local:8085" /></label>`}
        ${STANDALONE
          ? (EMBEDDED ? '' : '<p class="muted small">设备版直接访问 8085 端口。在 Leaf5C 上打开时地址用 <code>127.0.0.1:8085</code>；若页面放在电脑上，请填写设备 IP。</p>')
          : `<div class="discover-row">
              <button class="btn ghost" data-action="discover">${icon('search', 16)} 自动发现局域网设备</button>
              <span id="discover-status" class="muted"></span>
            </div>
            <div id="discover-results" class="discover-results"></div>`}
        <label class="field"><span>主题</span>
          <select id="theme-select" class="select">
            <option value="auto" ${state.theme === 'auto' ? 'selected' : ''}>跟随系统</option>
            <option value="light" ${state.theme === 'light' ? 'selected' : ''}>浅色</option>
            <option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>深色</option>
          </select>
        </label>
        <div class="shortcut-help">
          <h3>${icon('keyboard', 18)} 快捷键</h3>
          <div class="shortcut-grid">
            <span><kbd>/</kbd> 搜索</span><span><kbd>R</kbd> 刷新</span>
            <span><kbd>G</kbd> 切换视图</span><span><kbd>Esc</kbd> 关闭浮层</span>
            <span><kbd>←</kbd><kbd>→</kbd> 上一张 / 下一张</span><span><kbd>+</kbd><kbd>−</kbd> 缩放</span>
            <span><kbd>0</kbd> 适应窗口</span><span><kbd>1</kbd> 原始大小</span>
            <span><kbd>R</kbd> 旋转图片</span><span><kbd>D</kbd> 下载图片</span>
            <span><kbd>P</kbd> 幻灯片</span><span><kbd>Delete</kbd> 删除图片</span>
          </div>
        </div>
        <p class="muted small">文件会通过本机代理访问设备；图片缩略图与最近查看的文件缓存在 <code>.cache/</code>，可随时删除。</p>
      </div>
      <footer class="dialog-foot">
        ${EMBEDDED
          ? '<button class="btn primary" data-action="close-settings">关闭</button>'
          : '<button class="btn ghost" data-action="close-settings">取消</button><button class="btn primary" data-action="save-settings">保存并连接</button>'}
      </footer>
    </div></div>
  `
  document.body.classList.add('modal-open')
  root.querySelector('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeSettings()
  })
  root.querySelector<HTMLSelectElement>('#theme-select')?.addEventListener('change', (event) => {
    state.theme = (event.target as HTMLSelectElement).value as Theme
    localStorage.setItem('boox.theme', state.theme)
    applyTheme()
  })
  root.querySelector<HTMLInputElement>('#host-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void saveSettings()
  })
  requestAnimationFrame(() => root.querySelector<HTMLInputElement>('#host-input')?.focus())
}

function closeSettings(): void {
  const root = document.getElementById('modal-root')
  if (root) root.innerHTML = ''
  if (!document.querySelector('.lightbox')) document.body.classList.remove('modal-open')
}

async function saveSettings(): Promise<void> {
  if (EMBEDDED) {
    closeSettings()
    return
  }
  const input = document.getElementById('host-input') as HTMLInputElement | null
  const host = (input?.value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!host) return
  closeSettings()
  setHost(host)
  state.loading = false
  state.device = null
  state.online = false
  state.recent = []
  state.images = []
  state.books = []
  state.booksLoaded = false
  state.bookCovers = new Map()
  state.bookCoversLoaded = false
  bookCoversPromise = null
  state.files = { dir: '/storage/emulated/0', items: [], total: 0, fileCount: 0, folderCount: 0, loaded: false }
  await connect()
}

async function discover(): Promise<void> {
  const status = document.getElementById('discover-status')
  const results = document.getElementById('discover-results')
  if (!status || !results) return
  status.textContent = '正在扫描局域网…'
  results.innerHTML = ''
  try {
    const response = await fetch('/d/discover')
    const found: unknown = await response.json()
    const devices = Array.isArray(found)
      ? found
          .map((item) => (typeof item === 'object' && item !== null ? item as Record<string, unknown> : null))
          .filter((item): item is Record<string, unknown> => item !== null)
          .map((item) => ({ host: String(item.host || ''), model: String(item.model || ''), nickname: String(item.nickname || '') }))
          .filter((item) => item.host)
      : []
    if (!devices.length) {
      status.textContent = '没有找到设备，请确认与 Leaf5C 在同一网络。'
      return
    }
    status.textContent = `找到 ${devices.length} 台设备`
    results.innerHTML = devices.map((device) => `
      <button class="discover-item" data-action="use-host" data-host="${esc(device.host)}">
        <strong>${esc(device.nickname || device.model || 'BOOX')}</strong>
        <span class="mono">${esc(device.host)}</span>
      </button>
    `).join('')
  } catch (error) {
    status.textContent = messageOf(error)
  }
}

async function refresh(): Promise<void> {
  if (state.connecting) return
  try {
    state.device = await client.device()
    state.online = true
  } catch {
    state.online = false
  }
  renderStatus()
  await loadCurrent(true)
}

function bindEvents(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as Element
    const actionEl = target.closest<HTMLElement>('[data-action]')
    if (!actionEl) {
      closeMenu()
      return
    }
    if (!target.closest('.context-menu')) closeMenu()
    const action = actionEl.dataset.action
    const path = actionEl.dataset.path || ''
    if (action === 'tab') setTab(actionEl.dataset.tab as Tab)
    else if (action === 'refresh') void refresh()
    else if (action === 'toggle-view') toggleView()
    else if (action === 'theme') cycleTheme()
    else if (action === 'settings') openSettings()
    else if (action === 'close-settings') closeSettings()
    else if (action === 'save-settings') void saveSettings()
    else if (action === 'discover') void discover()
    else if (action === 'use-host') {
      const input = document.getElementById('host-input') as HTMLInputElement | null
      if (input) {
        input.value = actionEl.dataset.host || ''
        input.focus()
      }
    } else if (action === 'open') {
      const entry = findEntry(path)
      if (entry) openEntry(entry)
    } else if (action === 'open-book') {
      const book = state.books.find((item) => item.path === path)
      if (book) openBook(book)
    } else if (action === 'menu') {
      const entry = findEntry(path)
      if (entry) openMenu(actionEl, entry)
    } else if (action === 'navigate') {
      state.files.dir = path
      state.search = ''
      syncSearch()
      void loadFiles(true)
    } else if (action === 'new-folder') void createFolder()
    else if (action === 'upload-pick') pickFiles()
    else if (action === 'clear-uploads') {
      state.uploads = state.uploads.filter((task) => task.status === 'uploading' || task.status === 'queued')
      renderUploads()
    }
  })

  document.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement
    if (target.id === 'sort-select') {
      state.sort = target.value
      localStorage.setItem('boox.sort', state.sort)
      void loadFiles(true)
    }
  })

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    if (event.key === '/' && !typing && !isLightboxOpen()) {
      event.preventDefault()
      document.getElementById('search')?.focus()
      return
    }
    if (typing) return
    if (isLightboxOpen()) return
    if (event.key === 'Escape') {
      closeSettings()
      closePreview()
      return
    }
    if (event.key === 'r' || event.key === 'R') void refresh()
    else if (event.key === 'g' || event.key === 'G') toggleView()
    else if (event.key === '?') openSettings()
    else if (event.key === 'Enter' || event.key === ' ') {
      const active = document.activeElement as HTMLElement | null
      if (active?.dataset.action === 'open') {
        event.preventDefault()
        active.click()
      }
    }
  })

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme()
  })

  let dragDepth = 0
  const overlay = document.getElementById('drop-overlay')
  const showOverlay = (show: boolean) => overlay?.classList.toggle('visible', show)
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepth += 1
    const target = document.getElementById('drop-target')
    if (target) target.textContent = `→ ${uploadTarget()}`
    showOverlay(true)
  })
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  })
  document.addEventListener('dragleave', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) showOverlay(false)
  })
  document.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files.length) return
    event.preventDefault()
    dragDepth = 0
    showOverlay(false)
    queueUploads(Array.from(event.dataTransfer.files))
  })
  document.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files || [])
    if (files.length) queueUploads(files)
  })
}

async function boot(): Promise<void> {
  applyTheme()
  if (EMBEDDED) {
    setHost(location.host)
  } else if (STANDALONE) {
    const queryHost = new URLSearchParams(location.search).get('host')
    const fallback = location.protocol === 'file:' ? '127.0.0.1:8085' : `${location.hostname}:8085`
    setHost(queryHost || localStorage.getItem('boox.host') || fallback)
  } else if (!state.host) {
    try {
      const health: unknown = await fetch('/d/health').then((response) => response.json())
      const body = typeof health === 'object' && health !== null ? health as Record<string, unknown> : {}
      setHost(typeof body.defaultHost === 'string' ? body.defaultHost : 'boox.local:8085')
    } catch {
      setHost('boox.local:8085')
    }
  }
  renderShell()
  applyTheme()
  bindEvents()
  await connect()
}

void boot()
