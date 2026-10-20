import type { BooxClient, Book, Entry } from './api'
import { esc, fmtDateFull, fmtSize, icon, iconFor, kindOf, TEXT_EXT, extOf } from './format'

type PreviewHandlers = {
  deleteEntry(entry: Entry): Promise<boolean>
}

let keyHandler: ((event: KeyboardEvent) => void) | null = null
let previewToken = 0
const blobUrls: string[] = []

function clearModal(): void {
  previewToken += 1
  for (const url of blobUrls.splice(0)) URL.revokeObjectURL(url)
  const root = document.getElementById('modal-root')
  if (root) root.innerHTML = ''
  if (!document.querySelector('.lightbox')) document.body.classList.remove('modal-open')
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
}

export function closePreview(): void {
  clearModal()
}

function mount(inner: string): HTMLElement {
  clearModal()
  const root = document.getElementById('modal-root')
  if (!root) throw new Error('modal root missing')
  root.innerHTML = `<div class="modal-backdrop"><div class="modal preview-modal" data-stop>${inner}</div></div>`
  document.body.classList.add('modal-open')
  root.querySelector('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closePreview()
  })
  keyHandler = (event) => {
    if (event.key === 'Escape') closePreview()
  }
  window.addEventListener('keydown', keyHandler)
  return root
}

function footer(entry: Entry, allowRaw: boolean): string {
  return `
    <footer class="preview-foot">
      <div class="preview-meta">${esc(entry.path)}</div>
      <div class="preview-actions">
        <button class="btn ghost" data-preview="delete">${icon('trash', 16)} 删除</button>
        ${allowRaw ? `<button class="btn ghost" data-preview="raw">${icon('external', 16)} 新标签页</button>` : ''}
        <button class="btn primary" data-preview="download">${icon('download', 16)} 下载</button>
      </div>
    </footer>
  `
}

export async function openPreview(entry: Entry, client: BooxClient, handlers: PreviewHandlers): Promise<void> {
  const kind = entry.kind
  const stream = entry.size > 256 * 1024 * 1024
  const url = client.fileUrl(entry.path, entry.updatedAt, { stream })
  const downloadUrl = client.fileUrl(entry.path, entry.updatedAt, { download: true })
  const ext = extOf(entry.name)

  let body = ''
  if (kind === 'image') {
    body = `<div class="preview-image-wrap"><img class="preview-image" src="${esc(url)}" alt="${esc(entry.name)}" /></div>`
  } else if (kind === 'pdf') {
    body = entry.size > 300 * 1024 * 1024
      ? `<div class="preview-placeholder"><div class="preview-glyph">${iconFor('pdf', 64)}</div><p class="preview-hint">PDF 较大（${fmtSize(entry.size)}），下载后阅读更流畅。</p></div>`
      : client.mode !== 'proxy'
        ? `<div class="preview-loading" id="pdf-loading"><span class="spinner"></span><span>正在加载 PDF…</span></div>`
        : `<iframe class="preview-frame" src="${esc(url)}" title="${esc(entry.name)}"></iframe>`
  } else if (kind === 'video') {
    body = `<div class="preview-media"><video src="${esc(url)}" controls autoplay playsinline></video></div>`
  } else if (kind === 'audio') {
    body = `<div class="preview-media audio"><div class="audio-cover">${iconFor('audio', 54)}</div><audio src="${esc(url)}" controls autoplay></audio></div>`
  } else if (TEXT_EXT[ext] || kind === 'text') {
    body = `<div class="preview-text" id="preview-text"><span class="spinner"></span></div>`
  } else {
    body = `
      <div class="preview-placeholder">
        <div class="preview-glyph">${iconFor(kind, 64)}</div>
        <p class="preview-hint">${kind === 'book' ? '电子书无法在浏览器中直接打开，可下载后阅读。' : '此格式暂不支持预览。'}</p>
      </div>
    `
  }

  const root = mount(`
    <header class="preview-head">
      <div class="preview-title">
        <span class="preview-kind">${iconFor(kind, 18)}</span>
        <div>
          <h2>${esc(entry.name)}</h2>
          <p>${entry.format || ext.toUpperCase()} · ${fmtSize(entry.size)} · ${fmtDateFull(entry.updatedAt)}</p>
        </div>
      </div>
      <button class="icon-btn" data-preview="close" aria-label="关闭">${icon('close', 20)}</button>
    </header>
    <div class="preview-body">${body}</div>
    ${footer(entry, client.mode === 'proxy')}
  `)
  const token = previewToken

  if (kind === 'pdf' && client.mode !== 'proxy' && entry.size <= 300 * 1024 * 1024) {
    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(String(response.status))
        const blob = await response.blob()
        if (token !== previewToken) return
        const objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
        blobUrls.push(objectUrl)
        const frame = document.createElement('iframe')
        frame.className = 'preview-frame'
        frame.src = objectUrl
        frame.title = entry.name
        root.querySelector('#pdf-loading')?.replaceWith(frame)
      } catch {
        if (token !== previewToken) return
        const holder = root.querySelector('#pdf-loading')
        if (holder) holder.innerHTML = '<span>PDF 加载失败，请下载后查看。</span>'
      }
    })()
  }

  root.querySelector('[data-preview="close"]')?.addEventListener('click', closePreview)
  root.querySelector('[data-preview="download"]')?.addEventListener('click', () => {
    const anchor = document.createElement('a')
    anchor.href = downloadUrl
    anchor.download = entry.name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  })
  root.querySelector('[data-preview="raw"]')?.addEventListener('click', () => window.open(url, '_blank', 'noopener'))
  root.querySelector('[data-preview="delete"]')?.addEventListener('click', async () => {
    if (await handlers.deleteEntry(entry)) closePreview()
  })

  if (TEXT_EXT[ext] || kind === 'text') {
    const target = root.querySelector<HTMLElement>('#preview-text')
    if (!target) return
    if (entry.size > 2 * 1024 * 1024) {
      target.innerHTML = `<div class="preview-placeholder"><p class="preview-hint">文件较大（${fmtSize(entry.size)}），请下载后查看。</p></div>`
      return
    }
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(String(response.status))
      const content = await response.text()
      target.className = 'preview-text'
      target.innerHTML = `<pre>${esc(content)}</pre>`
    } catch {
      target.innerHTML = `<div class="preview-placeholder"><p class="preview-hint">无法读取文件内容。</p></div>`
    }
  }
}

export async function openBookPreview(book: Book, client: BooxClient, handlers: PreviewHandlers): Promise<void> {
  const cover = book.coverPath ? client.thumbUrl(book.coverPath, book.updatedAt, 420) : ''
  const kind = kindOf(book.name)
  const entry: Entry = {
    name: book.name,
    path: book.path,
    size: book.size,
    updatedAt: book.updatedAt,
    dir: false,
    kind,
    format: book.format,
  }
  const root = mount(`
    <header class="preview-head">
      <div class="preview-title">
        <span class="preview-kind">${iconFor('book', 18)}</span>
        <div>
          <h2>${esc(book.title)}</h2>
          <p>${esc(book.author || '未知作者')} · ${esc(book.format)} · ${fmtSize(book.size)}</p>
        </div>
      </div>
      <button class="icon-btn" data-preview="close" aria-label="关闭">${icon('close', 20)}</button>
    </header>
    <div class="preview-body">
      <div class="book-detail">
        ${cover ? `<img class="book-cover-large" src="${esc(cover)}" alt="" />` : `<div class="book-cover-large placeholder">${iconFor('book', 64)}</div>`}
        <div class="book-info">
          <h3>${esc(book.title)}</h3>
          <p class="muted">${esc(book.author || '未知作者')}</p>
          <dl>
            <div><dt>格式</dt><dd>${esc(book.format)}</dd></div>
            <div><dt>大小</dt><dd>${fmtSize(book.size)}</dd></div>
            <div><dt>阅读进度</dt><dd>${book.progress ? `${book.progress}%` : '未开始'}</dd></div>
            <div><dt>位置</dt><dd class="mono">${esc(book.path)}</dd></div>
          </dl>
          ${kind === 'image' ? '<p class="muted">封面图可直接下载查看。</p>' : ''}
        </div>
      </div>
    </div>
    <footer class="preview-foot">
      <div class="preview-meta">${esc(book.path)}</div>
      <div class="preview-actions">
        <button class="btn primary" data-preview="download">${icon('download', 16)} 下载</button>
        ${kind === 'pdf' ? '<button class="btn ghost" data-preview="open">' + icon('external', 16) + ' 浏览器阅读</button>' : ''}
      </div>
    </footer>
  `)

  root.querySelector('[data-preview="close"]')?.addEventListener('click', closePreview)
  root.querySelector('[data-preview="download"]')?.addEventListener('click', () => {
    const anchor = document.createElement('a')
    anchor.href = client.fileUrl(book.path, book.updatedAt, { download: true })
    anchor.download = book.name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  })
  root.querySelector('[data-preview="open"]')?.addEventListener('click', () => {
    void openPreview(entry, client, handlers)
  })
}
