const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function app() {
  class Element {
    children = []
    listeners = {}
    textContent = ''
    append(...children) { this.children.push(...children) }
    setAttribute() {}
    addEventListener(event, fn) { this.listeners[event] = fn }
    showModal() {}
  }
  const body = new Element(), actions = [], calls = []
  const state = { pinned: true, cached: false, failed: true, size: 60 }
  const context = {
    document: { hidden: false, activeElement: null, body, createElement: () => new Element(), addEventListener() {} },
    window: { OC: { requestToken: 'test' } },
    registerFileAction: action => actions.push(action), FileType: { File: 'file' }, generateUrl: url => url,
    setInterval() {}, setTimeout() {},
    fetch: async (url, options) => (calls.push({ route: url, body: JSON.parse(options.body) }), { ok: true, json: async () => url.endsWith('/status')
      ? { files: { 1: state }, budget: 40 } : { skipped: [] } }),
  }
  for (const name of ['mdiFire', 'mdiSnowflake', 'mdiPinOffOutline', 'mdiAlertCircleOutline', 'mdiRefresh', 'mdiTransfer']) context[name] = ''
  vm.createContext(context)
  const source = fs.readFileSync(path.join(__dirname, '../nextcloud/workspace_storage/src/workspace.js'), 'utf8')
  vm.runInContext(source.replace(/^import .*$/gm, ''), context)
  return { actions, calls, context }
}
const file = id => ({ id, path: `/workspace/${id}`, basename: id, type: 'file' })

test('clicking a failed icon retries the download', async () => {
  const { actions, calls, context } = app()
  const element = await actions.find(action => action.id === 'workspace-status').renderInline({ nodes: [file('1')] })
  vm.runInContext("states.set('1', { pinned: true, cached: false, failed: true, size: 60 })", context)
  await element.listeners.click({ stopPropagation() {} })
  assert.deepEqual(calls.at(-1), { route: '/apps/workspace_storage/action', body: { ids: ['1'], action: 'retry' } })
})

test('clicking any other icon does nothing', async () => {
  const { actions, calls, context } = app()
  const element = await actions.find(action => action.id === 'workspace-status').renderInline({ nodes: [file('1')] })
  vm.runInContext("states.set('1', { pinned: true, cached: true, failed: false, size: 60 })", context)
  await element.listeners.click({ stopPropagation() {} })
  assert.equal(calls.filter(call => call.route.endsWith('/action')).length, 0)
})

test('an already-pinned large file does not block a mixed selection', () => {
  const { actions, context } = app()
  vm.runInContext("budget = 40; states.set('1', { pinned: true, cached: true, size: 60 }); states.set('2', { pinned: false, cached: false, size: 30 })", context)
  const pin = actions.find(action => action.id === 'workspace-pin')
  assert.equal(pin.enabled({ nodes: [file('1'), file('2')] }), true)
  vm.runInContext("states.set('1', { pinned: false, cached: false, size: 60 })", context)
  assert.equal(pin.enabled({ nodes: [file('1')] }), false)
})
