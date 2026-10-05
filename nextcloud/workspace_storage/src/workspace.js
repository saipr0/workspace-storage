import { registerFileAction as registerNextcloudAction, getFileActions, DefaultType, FileType, Folder, View, getNavigation } from '@nextcloud/files'
import { generateUrl } from '@nextcloud/router'
import { mdiFire, mdiSnowflake, mdiPinOutline, mdiLoading, mdiAlertCircleOutline, mdiCached, mdiFolderOutline, mdiTransfer, mdiCloudUploadOutline } from '@mdi/js'

const svg = path => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="#fff" d="${path}"/></svg>`
const icon = svg(mdiTransfer)
function registerFileAction(action) {
  const execute = action.exec
  action.exec = async context => {
    try { return await execute(context) }
    catch (error) {
      const { element, content, actions } = dialog('Workspace storage')
      content.textContent = error.message
      actions.append(button('Close', () => element.close()))
      return false
    }
  }
  registerNextcloudAction(action)
}

const entries = new Map()
const states = new Map()
let refreshing = false
const inWorkspace = node => node.id && (node.path === '/workspace' || node.path.startsWith('/workspace/'))
const eligible = context => context.nodes.length > 0 && context.nodes.every(inWorkspace)
const bytes = value => {
  if (value < 1024) return `${value} B`
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${Number((value / 1024 ** unit).toFixed(2))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}
const downloading = s => s.availability && s.availability !== 'hot'
  && (s.job === 'warm' || (!s.job && s.active))

async function api(route, body) {
  const response = await fetch(generateUrl(`/apps/workspace_storage/${route}`), {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', requesttoken: window.OC.requestToken },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Workspace request failed')
  return data
}

function label(s) {
  if (!s) return 'Checking storage…'
  if (!s.availability) return 'Storage unavailable'
  const availability = { hot: 'Hot', cold: 'Cold', mixed: 'Mixed' }[s.availability]
  if (s.uploadRetries) return `${availability} · Upload retry pending`
  if (s.uploading) return `${availability} · Uploading`
  if (s.pendingUploads) return `${availability} · Upload pending`
  if (s.error) return `${availability} · Needs attention`
  if (s.job === 'cold') return `${availability} · Releasing local copy`
  if (downloading(s) && !s.active) return `${availability} · Queued`
  if (downloading(s)) {
    const percent = s.bytes ? Math.min(99, Math.floor(s.cached / s.bytes * 100)) : 0
    return `${availability} · Downloading ${percent}%`
  }
  return `${availability}${s.pinned ? ' · Pinned' : ''}`
}

function renderState(element, s) {
  const availability = s?.availability
  let icons = availability === 'hot' ? svg(mdiFire)
    : availability === 'cold' ? svg(mdiSnowflake)
    : availability === 'mixed' ? svg(mdiFire) + svg(mdiSnowflake) : svg(mdiAlertCircleOutline)
  if (s?.pinned) icons += svg(mdiPinOutline)
  if (s?.error || s?.uploadRetries) icons += svg(mdiAlertCircleOutline)
  else if ((downloading(s || {}) && s.active) || s?.uploading) icons += `<span class="workspace-spin">${svg(mdiLoading)}</span>`
  else if (s?.pendingUploads) icons += svg(mdiCloudUploadOutline)
  element.innerHTML = icons
  element.dataset.availability = availability || 'unknown'
  element.setAttribute('aria-label', label(s))
}

async function refresh() {
  if (refreshing || document.hidden) return
  const ids = []
  for (const [id, elements] of entries) {
    const visible = elements.filter(element => element.isConnected)
    if (visible.length) { entries.set(id, visible); ids.push(id) }
    else entries.delete(id)
  }
  if (!ids.length) return
  refreshing = true
  try {
    for (let offset = 0; offset < ids.length; offset += 30) {
      const result = await api('status', { ids: ids.slice(offset, offset + 30) })
      for (const [id, state] of Object.entries(result)) {
        states.set(String(id), state)
        for (const element of entries.get(String(id)) || []) {
          renderState(element, state)
        }
      }
    }
  } catch {
    for (const elements of entries.values()) for (const element of elements) renderState(element, {error: 'Storage unavailable'})
  } finally { refreshing = false }
}
setInterval(refresh, 3000)
document.addEventListener('visibilitychange', refresh)

function dialog(title) {
  const previous = document.activeElement
  const element = document.createElement('dialog')
  element.className = 'workspace-dialog'
  const heading = document.createElement('h2')
  heading.id = 'workspace-dialog-title'
  heading.textContent = title
  element.setAttribute('aria-labelledby', heading.id)
  const content = document.createElement('div')
  content.className = 'workspace-dialog-content'
  const actions = document.createElement('div')
  actions.className = 'workspace-dialog-actions'
  element.append(heading, content, actions)
  document.body.append(element)
  element.addEventListener('close', () => { element.remove(); previous?.focus() }, { once: true })
  element.showModal()
  return { element, content, actions }
}

function button(label, fn, primary = false) {
  const b = document.createElement('button')
  b.type = 'button'; b.textContent = label
  if (primary) b.className = 'primary'
  b.addEventListener('click', fn)
  return b
}

async function change(node, action) {
  await api('action', { id: node.id, action })
  await refresh()
}

async function showStatus(node, preparing = false) {
  const { element, content, actions } = dialog(node.basename)
  const summary = document.createElement('p')
  summary.setAttribute('role', 'status')
  const progress = document.createElement('progress')
  progress.hidden = true
  progress.max = 100
  progress.setAttribute('aria-label', 'Local download progress')
  const detail = document.createElement('p')
  detail.className = 'workspace-detail'
  content.append(summary, progress, detail)
  actions.append(button('Continue browsing', () => element.close()))
  const cancel = button('Cancel download', async () => {
    cancel.disabled = true
    try { await change(node, 'cancel'); element.close() }
    catch (e) { detail.textContent = e.message; cancel.disabled = false }
  })
  cancel.hidden = true
  actions.append(cancel)
  let result = false
  let stopped = false
  const closed = new Promise(resolve => element.addEventListener('close', () => { stopped = true; resolve(result) }, { once: true }))
  async function update() {
    if (stopped) return
    try {
      const data = await api('status', { ids: [node.id] })
      const s = data[node.id]
      states.set(node.id, s)
      summary.textContent = label(s)
      const pending = downloading(s)
      progress.hidden = !pending
      cancel.hidden = !pending
      cancel.textContent = s.pinned ? 'Cancel download and unpin' : 'Cancel download'
      progress.value = s.bytes ? Math.min(100, s.cached / s.bytes * 100) : 0
      const note = pending ? 'Downloads continue when you close this panel.'
        : s.availability === 'hot' ? (s.pinned ? 'Kept on this server until you unpin it.' : 'Available on this server; automatic caching may release the local copy.') : ''
      detail.textContent = s.availability
        ? `${bytes(s.cached || 0)} local of ${bytes(s.bytes || 0)}. ${s.error || note}`.trim()
        : (s.error || 'Storage status unavailable')
      if (preparing && s.availability === 'hot' && !stopped) { result = true; element.close(); return }
    } catch (e) { progress.hidden = true; cancel.hidden = true; detail.textContent = e.message }
    if (!stopped) setTimeout(update, 1500)
  }
  update()
  return closed
}

registerFileAction({
  id: 'workspace-status', displayName: () => 'Storage status', iconSvgInline: () => icon,
  enabled: eligible, order: 40,
  renderInline: async ({ nodes }) => {
    const node = nodes[0]
    const element = button('', event => { event.stopPropagation(); showStatus(node) })
    renderState(element, states.get(node.id))
    element.className = 'workspace-status'
    const existing = entries.get(node.id) || []
    entries.set(node.id, [...existing, element])
    setTimeout(refresh, 50)
    return element
  },
  exec: async ({ nodes }) => { await showStatus(nodes[0]); return null },
})

for (const [action, name, glyph] of [['pin', 'Keep hot', mdiFire], ['cold', 'Make cold', mdiSnowflake], ['auto', 'Allow automatic caching', mdiCached], ['inherit', 'Use parent folder policy', mdiFolderOutline]]) {
  registerFileAction({
    id: `workspace-${action}`, displayName: () => name, iconSvgInline: () => svg(glyph),
    enabled: eligible, order: 41,
    exec: async ({ nodes }) => { await change(nodes[0], action); return true },
    execBatch: async ({ nodes }) => Promise.all(nodes.map(async node => { await change(node, action); return true })),
  })
}

registerFileAction({
  id: 'workspace-open', displayName: () => 'Open', iconSvgInline: () => icon,
  default: DefaultType.HIDDEN, order: -1000,
  enabled: context => eligible(context) && context.nodes.length === 1 && context.nodes[0].type === FileType.File,
  exec: async context => {
    const node = context.nodes[0]
    const data = await api('status', { ids: [node.id] })
    if (data[node.id]?.availability !== 'hot') {
      await change(node, 'warm')
      if (!await showStatus(node, true)) return null
    }
    const action = getFileActions().filter(action => action.id !== 'workspace-open' && action.default
      && (!action.enabled || action.enabled(context))).sort((a, b) => (a.order || 0) - (b.order || 0))[0]
    if (action) return action.exec(context)
    window.location.assign(node.encodedSource)
    return null
  },
})

registerFileAction({
  id: 'workspace-settings', displayName: () => 'Local storage budget', iconSvgInline: () => icon,
  enabled: ({ nodes }) => nodes.length === 1 && nodes[0].path === '/workspace', order: 43,
  exec: async () => {
    const data = await api('settings', {})
    const { element, content, actions } = dialog('Local storage budget')
    const label = document.createElement('label')
    label.textContent = 'Maximum local cache target (GiB)'
    const input = document.createElement('input')
    input.type = 'number'; input.min = '0.001'; input.step = 'any'; input.value = data.state.budget / 1024 ** 3
    label.append(input)
    const note = document.createElement('p')
    note.className = 'workspace-detail'
    note.textContent = `${bytes(data.cache.bytesUsed)} currently cached. Pins and pending uploads are protected even when they exceed this target.`
    content.append(label, note)
    actions.append(button('Cancel', () => element.close()), button('Save', async () => {
      if (!input.reportValidity()) return
      try { await api('settings', { budget: Math.round(Number(input.value) * 1024 ** 3) }); element.close() }
      catch (e) { note.textContent = e.message }
    }, true))
    return null
  },
})

function renderActivity(container) {
  const panel = document.createElement('section')
  panel.className = 'workspace-activity'
  const heading = document.createElement('h2')
  heading.textContent = 'Workspace activity'
  const summary = document.createElement('p')
  summary.className = 'workspace-detail'
  summary.textContent = 'Loading transfers…'
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  const note = document.createElement('p')
  note.className = 'workspace-detail'
  note.textContent = 'Cancelling a pinned download also removes its pin.'
  const list = document.createElement('div')
  list.className = 'workspace-transfers'
  const rows = new Map()
  let busy = false
  let loading = false
  const cancelAll = button('Cancel all downloads', () => cancel(null))
  cancelAll.hidden = true
  async function cancel(path) {
    if (busy) return
    busy = true
    cancelAll.disabled = true
    for (const row of rows.values()) row.cancel.disabled = true
    try { await api('cancel', path === null ? {} : {path}); error.textContent = '' }
    catch (e) { error.textContent = e.message }
    finally { busy = false; await update() }
  }
  panel.append(heading, summary, cancelAll, note, error, list)
  container.replaceChildren(panel)
  async function update() {
    if (!panel.isConnected || busy || loading) return
    loading = true
    try {
      const {items} = await api('activity', {})
      if (!panel.isConnected) return
      const downloads = items.filter(item => item.kind === 'download').length
      const uploads = items.filter(item => item.kind === 'upload').length
      summary.textContent = items.length ? `${downloads} downloads · ${uploads} uploads` : 'No transfers in progress.'
      cancelAll.hidden = !downloads
      cancelAll.disabled = busy
      note.hidden = !items.some(item => item.canCancel && item.pinned)
      const keys = new Set()
      for (const item of items) {
        const key = `${item.kind}:${item.path}`
        keys.add(key)
        let row = rows.get(key)
        if (!row) {
          const element = document.createElement('article')
          element.className = 'workspace-transfer'
          const symbol = document.createElement('span')
          symbol.className = 'workspace-status'
          const body = document.createElement('div')
          const name = document.createElement('strong')
          name.textContent = item.path || 'workspace'
          const status = document.createElement('p')
          const detail = document.createElement('p')
          detail.className = 'workspace-detail'
          const progress = document.createElement('progress')
          progress.max = 100
          progress.setAttribute('aria-label', `Download progress for ${name.textContent}`)
          const stop = button('Cancel download', () => cancel(item.path))
          body.append(name, status, detail, progress)
          element.append(symbol, body, stop)
          list.append(element)
          row = {element, symbol, status, detail, progress, cancel: stop}
          rows.set(key, row)
        }
        renderState(row.symbol, item)
        row.status.textContent = item.kind === 'upload'
          ? (item.uploadRetries ? 'Upload retry pending' : item.uploading ? 'Uploading' : 'Upload pending')
          : item.kind === 'release' ? 'Releasing local copy'
          : item.error ? 'Download needs attention' : item.active ? 'Downloading' : 'Queued'
        row.detail.textContent = [item.kind === 'download' ? `${bytes(item.cached || 0)} of ${bytes(item.bytes || 0)}` : bytes(item.bytes || 0),
          item.current && item.current !== item.path ? item.current : '', item.error || ''].filter(Boolean).join(' · ')
        row.progress.hidden = item.kind !== 'download' || !item.bytes
        row.progress.value = item.bytes ? Math.min(100, (item.cached || 0) / item.bytes * 100) : 0
        row.cancel.hidden = !item.canCancel
        row.cancel.disabled = busy
        row.cancel.textContent = item.pinned ? 'Cancel and unpin' : 'Cancel download'
      }
      for (const [key, row] of rows) if (!keys.has(key)) { row.element.remove(); rows.delete(key) }
    } catch (e) {
      summary.textContent = e.message
      cancelAll.hidden = true
    } finally { loading = false }
  }
  update()
  const timer = setInterval(() => {
    if (!panel.isConnected) clearInterval(timer)
    else if (!document.hidden) update()
  }, 2000)
}

getNavigation().register(new View({
  id: 'workspace-activity', name: 'Workspace activity', icon, order: 35,
  getContents: async () => ({
    folder: new Folder({source: new URL(generateUrl('/apps/files/workspace-activity'), window.location.origin).href, root: '/', owner: null, permissions: 0}),
    contents: [],
  }),
  emptyView: renderActivity,
}))
