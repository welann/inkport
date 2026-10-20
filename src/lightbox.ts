import type { Entry } from './api'
import { clamp, fmtDateFull, fmtSize, icon } from './format'

export type LightboxHandlers = {
  url(entry: Entry): string
  downloadUrl(entry: Entry): string
  allowRaw: boolean
  deleteEntry(entry: Entry): Promise<boolean>
}

type Pointer = { x: number; y: number }

let root: HTMLElement | null = null
let items: Entry[] = []
let index = 0
let handlers: LightboxHandlers | null = null
let scale = 1
let fitScale = 1
let tx = 0
let ty = 0
let rot = 0
let naturalW = 0
let naturalH = 0
let stage: HTMLElement | null = null
let image: HTMLImageElement | null = null
let spinner: HTMLElement | null = null
let slideshow = 0
let keyHandler: ((event: KeyboardEvent) => void) | null = null

const pointers = new Map<number, Pointer>()
let drag: { x: number; y: number; tx: number; ty: number } | null = null
let pinchDistance = 0
let pinchMid: Pointer | null = null

export function isLightboxOpen(): boolean {
  return root !== null
}

export function openLightbox(entries: Entry[], start: number, h: LightboxHandlers): void {
  const images = entries.filter((entry) => entry.kind === 'image')
  if (!images.length) return
  closeLightbox()
  items = images
  handlers = h
  index = Math.min(Math.max(start, 0), images.length - 1)
  root = document.getElementById('lightbox-root')
  if (!root) return
  document.body.classList.add('lb-open')
  mount()
  keyHandler = (event) => onKey(event)
  window.addEventListener('keydown', keyHandler)
  show(index)
}

export function closeLightbox(): void {
  if (slideshow) {
    clearInterval(slideshow)
    slideshow = 0
  }
  if (keyHandler) window.removeEventListener('keydown', keyHandler)
  keyHandler = null
  pointers.clear()
  drag = null
  if (root) root.innerHTML = ''
  root = null
  stage = null
  image = null
  spinner = null
  items = []
  handlers = null
  document.body.classList.remove('lb-open')
  if (!document.querySelector('.modal-backdrop')) document.body.classList.remove('modal-open')
}

function mount(): void {
  if (!root) return
  root.innerHTML = `
    <div class="lightbox" role="dialog" aria-modal="true" aria-label="图片查看器">
      <div class="lb-top">
        <div class="lb-title">
          <strong id="lb-name"></strong>
          <span id="lb-count" class="lb-count"></span>
        </div>
        <div class="lb-actions">
          <button class="lb-btn" data-lb="slideshow" title="幻灯片 (P)">${icon('play', 18)}</button>
          <button class="lb-btn" data-lb="download" title="下载 (D)">${icon('download', 18)}</button>
          ${handlers?.allowRaw ? `<button class="lb-btn" data-lb="raw" title="新标签页打开">${icon('external', 18)}</button>` : ''}
          <button class="lb-btn danger" data-lb="delete" title="删除 (Delete)">${icon('trash', 18)}</button>
          <button class="lb-btn" data-lb="close" title="关闭 (Esc)">${icon('close', 18)}</button>
        </div>
      </div>
      <div class="lb-stage" id="lb-stage">
        <img id="lb-img" alt="" draggable="false" />
        <div class="lb-loading" id="lb-loading"><span class="spinner"></span></div>
        <button class="lb-nav prev" data-lb="prev" title="上一张 (←)">${icon('chevronLeft', 28)}</button>
        <button class="lb-nav next" data-lb="next" title="下一张 (→)">${icon('chevronRight', 28)}</button>
      </div>
      <div class="lb-bottom">
        <div class="lb-meta" id="lb-meta"></div>
        <div class="lb-tools">
          <button class="lb-btn" data-lb="zoom-out" title="缩小 (-)">${icon('minus', 18)}</button>
          <button class="lb-btn wide" data-lb="fit" title="适应窗口 (0)">适应</button>
          <button class="lb-btn wide" data-lb="actual" title="原始大小 (1)">100%</button>
          <button class="lb-btn" data-lb="zoom-in" title="放大 (+)">${icon('plus', 18)}</button>
          <button class="lb-btn" data-lb="rotate" title="旋转 (R)">${icon('rotate', 18)}</button>
        </div>
      </div>
    </div>
  `
  stage = root.querySelector<HTMLElement>('#lb-stage')
  image = root.querySelector<HTMLImageElement>('#lb-img')
  spinner = root.querySelector<HTMLElement>('#lb-loading')
  if (!stage || !image) return
  stage.addEventListener('wheel', onWheel, { passive: false })
  stage.addEventListener('pointerdown', onPointerDown)
  stage.addEventListener('pointermove', onPointerMove)
  stage.addEventListener('pointerup', onPointerUp)
  stage.addEventListener('pointercancel', onPointerUp)
  stage.addEventListener('dblclick', onDoubleClick)
  root.addEventListener('click', onRootClick)
}

function show(next: number): void {
  if (!items.length || !image || !handlers) return
  index = (next + items.length) % items.length
  const entry = items[index]
  if (!entry) return
  rot = 0
  scale = 1
  tx = 0
  ty = 0
  naturalW = 0
  naturalH = 0
  image.style.transform = ''
  image.style.visibility = 'hidden'
  spinner?.classList.remove('hidden')

  const name = root?.querySelector<HTMLElement>('#lb-name')
  const count = root?.querySelector<HTMLElement>('#lb-count')
  if (name) name.textContent = entry.name
  if (count) count.textContent = `${index + 1} / ${items.length}`

  const meta = root?.querySelector<HTMLElement>('#lb-meta')
  if (meta) meta.textContent = `${fmtSize(entry.size)} · ${fmtDateFull(entry.updatedAt)}`

  image.onload = () => {
    if (!image) return
    naturalW = image.naturalWidth
    naturalH = image.naturalHeight
    image.style.visibility = 'visible'
    spinner?.classList.add('hidden')
    fit()
    if (meta) {
      meta.textContent = `${naturalW}×${naturalH} · ${fmtSize(entry.size)} · ${fmtDateFull(entry.updatedAt)}`
    }
  }
  image.onerror = () => {
    spinner?.classList.add('hidden')
    if (meta) meta.textContent = '图片加载失败'
  }
  image.src = handlers.url(entry)

  const nextEntry = items[(index + 1) % items.length]
  const prevEntry = items[(index - 1 + items.length) % items.length]
  for (const neighbor of [nextEntry, prevEntry]) {
    if (neighbor && neighbor !== entry) {
      const preload = new Image()
      preload.src = handlers.url(neighbor)
    }
  }
}

function apply(): void {
  if (!image) return
  image.style.transform = `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rot}deg)`
}

function fit(): void {
  if (!stage || !image || !naturalW || !naturalH) return
  const pad = 28
  const availW = Math.max(40, stage.clientWidth - pad * 2)
  const availH = Math.max(40, stage.clientHeight - pad * 2)
  const rotated = rot % 180 !== 0
  const width = rotated ? naturalH : naturalW
  const height = rotated ? naturalW : naturalH
  fitScale = clamp(Math.min(availW / width, availH / height), 0.02, 8)
  scale = fitScale
  tx = 0
  ty = 0
  apply()
}

function actual(): void {
  scale = 1
  tx = 0
  ty = 0
  apply()
}

function zoomAt(px: number, py: number, factor: number): void {
  if (!stage) return
  const next = clamp(scale * factor, 0.04, 12)
  const ratio = next / scale
  tx = px - (px - tx) * ratio
  ty = py - (py - ty) * ratio
  scale = next
  apply()
}

function zoomBy(factor: number): void {
  if (!stage) return
  zoomAt(0, 0, factor)
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  if (!stage) return
  const rect = stage.getBoundingClientRect()
  const px = event.clientX - rect.left - rect.width / 2
  const py = event.clientY - rect.top - rect.height / 2
  zoomAt(px, py, Math.exp(-event.deltaY * 0.0015))
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  if ((event.target as Element).closest('button')) return
  if (!stage) return
  stage.setPointerCapture(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pointers.size === 1) {
    drag = { x: event.clientX, y: event.clientY, tx, ty }
    stage.classList.add('dragging')
  } else if (pointers.size === 2) {
    drag = null
    const [a, b] = [...pointers.values()]
    if (a && b) {
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y)
      pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    if (!a || !b || !stage) return
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const rect = stage.getBoundingClientRect()
    if (pinchDistance > 0) zoomAt(mid.x - rect.left - rect.width / 2, mid.y - rect.top - rect.height / 2, distance / pinchDistance)
    if (pinchMid) {
      tx += mid.x - pinchMid.x
      ty += mid.y - pinchMid.y
      apply()
    }
    pinchDistance = distance
    pinchMid = mid
    return
  }

  if (drag) {
    tx = drag.tx + (event.clientX - drag.x)
    ty = drag.ty + (event.clientY - drag.y)
    apply()
  }
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId)
  if (pointers.size === 0) {
    drag = null
    pinchDistance = 0
    pinchMid = null
    stage?.classList.remove('dragging')
  } else if (pointers.size === 1) {
    const [remaining] = [...pointers.values()]
    if (remaining) drag = { x: remaining.x, y: remaining.y, tx, ty }
    pinchDistance = 0
    pinchMid = null
  }
}

function onDoubleClick(event: MouseEvent): void {
  if ((event.target as Element).closest('button')) return
  if (scale > fitScale * 1.15) fit()
  else actual()
}

function rotate(): void {
  rot = (rot + 90) % 360
  fit()
}

function download(): void {
  const entry = items[index]
  if (!entry || !handlers) return
  const anchor = document.createElement('a')
  anchor.href = handlers.downloadUrl(entry)
  anchor.download = entry.name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function toggleSlideshow(): void {
  const button = root?.querySelector<HTMLElement>('[data-lb="slideshow"]')
  if (slideshow) {
    clearInterval(slideshow)
    slideshow = 0
    button?.classList.remove('active')
    return
  }
  slideshow = window.setInterval(() => show(index + 1), 4000)
  button?.classList.add('active')
}

async function removeCurrent(): Promise<void> {
  const entry = items[index]
  if (!entry || !handlers) return
  if (!(await handlers.deleteEntry(entry))) return
  items = items.filter((item) => item !== entry)
  if (!items.length) {
    closeLightbox()
    return
  }
  show(index % items.length)
}

function onRootClick(event: MouseEvent): void {
  const button = (event.target as Element).closest<HTMLElement>('[data-lb]')
  if (!button) return
  const action = button.dataset.lb
  if (action === 'close') closeLightbox()
  else if (action === 'prev') show(index - 1)
  else if (action === 'next') show(index + 1)
  else if (action === 'zoom-in') zoomBy(1.35)
  else if (action === 'zoom-out') zoomBy(1 / 1.35)
  else if (action === 'fit') fit()
  else if (action === 'actual') actual()
  else if (action === 'rotate') rotate()
  else if (action === 'download') download()
  else if (action === 'raw') {
    const entry = items[index]
    if (entry && handlers?.allowRaw) window.open(handlers.url(entry), '_blank', 'noopener')
  } else if (action === 'slideshow') toggleSlideshow()
  else if (action === 'delete') void removeCurrent()
}

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  if (event.key === 'Escape') {
    closeLightbox()
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    show(index - 1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    show(index + 1)
  } else if (event.key === '+' || event.key === '=') {
    zoomBy(1.35)
  } else if (event.key === '-') {
    zoomBy(1 / 1.35)
  } else if (event.key === '0') {
    fit()
  } else if (event.key === '1') {
    actual()
  } else if (event.key === 'r' || event.key === 'R') {
    rotate()
  } else if (event.key === 'd' || event.key === 'D') {
    download()
  } else if (event.key === 'p' || event.key === 'P') {
    toggleSlideshow()
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    void removeCurrent()
  }
}
