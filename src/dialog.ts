import { deferred } from './deferred'
import { esc, icon } from './format'

function clear(root: HTMLElement): void {
  root.innerHTML = ''
  if (!document.querySelector('#modal-root .modal-backdrop') && !document.querySelector('#dialog-root .modal-backdrop') && !document.querySelector('.lightbox')) {
    document.body.classList.remove('modal-open')
  }
}

function shell(inner: string): HTMLElement {
  const root = document.getElementById('dialog-root')
  if (!root) throw new Error('dialog root missing')
  root.innerHTML = `<div class="modal-backdrop"><div class="modal dialog" data-stop>${inner}</div></div>`
  document.body.classList.add('modal-open')
  return root
}

export function askText(options: {
  title: string
  label: string
  value?: string
  confirmText?: string
}): Promise<string | null> {
  const { promise, resolve } = deferred<string | null>()
  const root = shell(`
    <header class="dialog-head"><h2>${esc(options.title)}</h2><button class="icon-btn" data-dialog="cancel" aria-label="关闭">${icon('close', 18)}</button></header>
    <div class="dialog-body">
      <label class="field"><span>${esc(options.label)}</span><input id="dialog-input" value="${esc(options.value || '')}" autocomplete="off" spellcheck="false" /></label>
    </div>
    <footer class="dialog-foot">
      <button class="btn ghost" data-dialog="cancel">取消</button>
      <button class="btn primary" data-dialog="ok">${esc(options.confirmText || '确定')}</button>
    </footer>
  `)
  const input = root.querySelector<HTMLInputElement>('#dialog-input')
  const finish = (value: string | null) => {
    clear(root)
    resolve(value)
  }
  const submit = () => {
    const value = (input?.value || '').trim()
    if (!value) {
      input?.focus()
      return
    }
    finish(value)
  }
  root.querySelector('[data-dialog="ok"]')?.addEventListener('click', submit)
  root.querySelectorAll('[data-dialog="cancel"]').forEach((button) => button.addEventListener('click', () => finish(null)))
  root.querySelector('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) finish(null)
  })
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
    if (event.key === 'Escape') finish(null)
  })
  requestAnimationFrame(() => {
    input?.focus()
    input?.select()
  })
  return promise
}

export function askConfirm(options: { title: string; message: string; confirmText?: string; danger?: boolean }): Promise<boolean> {
  const { promise, resolve } = deferred<boolean>()
  const root = shell(`
    <header class="dialog-head"><h2>${esc(options.title)}</h2><button class="icon-btn" data-dialog="cancel" aria-label="关闭">${icon('close', 18)}</button></header>
    <div class="dialog-body"><p class="confirm-text">${esc(options.message)}</p></div>
    <footer class="dialog-foot">
      <button class="btn ghost" data-dialog="cancel">取消</button>
      <button class="btn ${options.danger ? 'danger' : 'primary'}" data-dialog="ok">${esc(options.confirmText || '确定')}</button>
    </footer>
  `)
  let onKey: ((event: KeyboardEvent) => void) | null = null
  const finish = (value: boolean) => {
    if (onKey) window.removeEventListener('keydown', onKey)
    clear(root)
    resolve(value)
  }
  root.querySelector('[data-dialog="ok"]')?.addEventListener('click', () => finish(true))
  root.querySelectorAll('[data-dialog="cancel"]').forEach((button) => button.addEventListener('click', () => finish(false)))
  root.querySelector('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) finish(false)
  })
  onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') finish(false)
  }
  window.addEventListener('keydown', onKey)
  requestAnimationFrame(() => root.querySelector<HTMLElement>('[data-dialog="ok"]')?.focus())
  return promise
}
