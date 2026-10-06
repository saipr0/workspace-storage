import { registerFileAction, FileType } from '@nextcloud/files'
import { generateUrl } from '@nextcloud/router'
import { mdiFire, mdiSnowflake, mdiPinOffOutline, mdiAlertCircleOutline, mdiRefresh, mdiTransfer } from '@mdi/js'

const svg = path => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="#fff" d="${path}"/></svg>`
const icon = svg(mdiTransfer)

const entries = new Map()
const states = new Map()
let budget = -1
let refreshing = false
const inWorkspace = node => node.id && (node.path === '/workspace' || node.path.startsWith('/workspace/'))
const eligible = context => context.nodes.length > 0 && context.nodes.every(inWorkspace)
const isFile = s => 'cached' in s

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
  if (s.error) return s.error
  if (s.failed) return 'Hot, but the download failed'
  if (!isFile(s)) return s.mixed ? 'Mixed' : s.pinned ? 'Hot' : 'Folder'
  if (s.pinned) return s.cached ? 'Hot and kept on this server' : 'Hot, downloading to this server'
  if (s.releasing) return 'Releasing, it becomes cold once free'
  return s.cached ? 'On this server' : 'Cold'
}

function renderState(element, s) {
  let icons = ''
  if (s?.error) icons = svg(mdiAlertCircleOutline)
  else if (s?.failed) icons = svg(mdiRefresh)
  else if (s && !isFile(s)) icons = s.mixed ? svg(mdiFire) + svg(mdiSnowflake) : s.pinned ? svg(mdiFire) : ''
  else if (s?.pinned) icons = s.cached ? svg(mdiFire) : `<span class="workspace-pulse">${svg(mdiFire)}</span>`
  else if (s?.releasing) icons = `<span class="workspace-pulse">${svg(mdiSnowflake)}</span>`
  else if (s && !s.cached) icons = svg(mdiSnowflake)
  element.innerHTML = icons
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
      const batch = ids.slice(offset, offset + 30)
      const result = await api('status', { ids: batch })
      budget = result.budget
      for (const id of batch) {
        const state = result.files[id] || { error: 'Storage status unavailable' }
        states.set(id, state)
        for (const element of entries.get(id) || []) renderState(element, state)
      }
    }
  } catch {
    for (const elements of entries.values()) for (const element of elements) renderState(element, { error: 'Storage unavailable' })
  } finally { refreshing = false }
}
setInterval(refresh, 3000)
document.addEventListener('visibilitychange', refresh)

function toast(message, failed = false) {
  const element = document.createElement('div')
  element.className = failed ? 'workspace-toast workspace-toast-error' : 'workspace-toast'
  element.setAttribute('role', 'alert')
  element.textContent = message
  document.body.append(element)
  setTimeout(() => element.remove(), 7000)
}

async function change(nodes, action) {
  const { skipped } = await api('action', { ids: nodes.map(node => node.id), action })
  await refresh()
  return skipped
}

function done(nodes, action, skipped) {
  const what = nodes.length === 1 ? nodes[0].basename : `${nodes.length} items`
  if (action === 'pin') return `${what} will be kept on this server`
  if (action === 'unpin') return `${what} is no longer kept on this server`
  if (action === 'retry') return `Downloading ${what} again`
  return skipped.length ? `${what} will be removed from this server once it is free` : `${what} was removed from this server`
}

registerFileAction({
  id: 'workspace-status', displayName: () => 'Storage status', iconSvgInline: () => icon,
  enabled: ({ nodes }) => nodes.length === 1 && nodes[0].id && nodes[0].path.startsWith('/workspace/'), order: 40,
  renderInline: async ({ nodes }) => {
    const node = nodes[0]
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'workspace-status'
    element.addEventListener('click', async event => {
      event.stopPropagation()
      if (!states.get(node.id)?.failed) return
      try { toast(done([node], 'retry', await change([node], 'retry'))) }
      catch (error) { toast(`Could not retry the download: ${error.message}`, true) }
    })
    renderState(element, states.get(node.id))
    const existing = entries.get(node.id) || []
    entries.set(node.id, [...existing, element])
    setTimeout(refresh, 50)
    return element
  },
  exec: async () => null,
})

const fits = ({ nodes }) => budget < 0 || nodes.every(node => node.type !== FileType.File
  || states.get(node.id)?.pinned || (states.get(node.id)?.size ?? 0) <= budget)

for (const [action, name, glyph, enabled] of [
  ['pin', 'Keep hot', mdiFire, context => eligible(context) && fits(context)],
  ['unpin', 'Unpin', mdiPinOffOutline, context => eligible(context) && context.nodes.some(node => states.get(node.id)?.pinned)],
  ['cold', 'Make cold', mdiSnowflake, eligible],
  ['retry', 'Retry download', mdiRefresh, context => eligible(context) && context.nodes.every(node => states.get(node.id)?.failed)],
]) {
  registerFileAction({
    id: `workspace-${action}`, displayName: () => name, iconSvgInline: () => svg(glyph),
    enabled, order: 41,
    // Returning null stops Nextcloud adding its own "done" or "failed" toast.
    exec: async ({ nodes }) => {
      try { toast(done(nodes, action, await change(nodes, action))) }
      catch (error) { toast(`Could not ${name.toLowerCase()}: ${error.message}`, true) }
      return null
    },
    execBatch: async ({ nodes }) => {
      try { toast(done(nodes, action, await change(nodes, action))) }
      catch (error) { toast(`Could not ${name.toLowerCase()}: ${error.message}`, true) }
      return nodes.map(() => null)
    },
  })
}
