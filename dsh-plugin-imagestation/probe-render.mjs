/**
 * Regression probe for the no-JSX h() helper and the two components the bundle registers.
 *
 * h() carries an inherent ambiguity (is the second argument props or children?) and it has
 * already produced three distinct bugs in this file. This probe pins every calling
 * convention down with an assertion, then renders both registered components through real
 * React and checks the markup that comes out.
 *
 * Uses the dev-only react/react-dom installed in this directory (`npm install --no-save`).
 * Nothing here ships: the browser bundle itself has no dependencies.
 *
 * Usage: node probe-render.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)

let React
let ReactDOMServer
try {
  React = require_('react')
  ReactDOMServer = require_('react-dom/server')
} catch {
  console.error('react/react-dom not installed here. Run: npm install --no-save react@18 react-dom@18')
  process.exit(2)
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok    ' + label)
  } else {
    console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : ''))
    failures.push(label)
  }
}

/* ---------- load the bundle and capture its exports + registered components ---------- */
let registration = null
function loadBundle() {
  const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
  const req = (spec) => {
    if (spec === 'react') return React
    throw new Error('bundle requested a non-seed module: ' + spec)
  }
  new Function('require', 'window', 'document', source)(
    req,
    { __ModuleLoader__: { load: (r) => { registration = r } } },
    {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild() {} },
    },
  )
  return registration.factory(req)
}

const exportsObj = loadBundle()
console.log('bundle id      :', registration.id)
console.log('exports.inject :', JSON.stringify(exportsObj.inject))
console.log('')

/* ---------- 1. the inject contract: omitting it caused "entry did not activate" ---------- */
console.log('service injection declaration:')
check('exports.inject is an array', Array.isArray(exportsObj.inject), typeof exportsObj.inject)
for (const svc of ['slots', 'locale', 'layout']) {
  check('declares service "' + svc + '"', (exportsObj.inject || []).includes(svc))
}
console.log('')

/* ---------- 2. collect the components through a recording ctx ---------- */
const collected = []
const ctx = {
  locale: { bind: () => (k) => k, register: () => () => {} },
  effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
  slots: {
    inject(key, cb) {
      const effect = cb()
      // The registry accepts either a synchronous disposer or an iterable of them.
      if (effect && typeof effect !== 'function' && typeof effect[Symbol.iterator] === 'function') {
        for (const d of effect) void d
      }
      return () => {}
    },
    register(options, component) {
      collected.push({ options, component })
      return () => {}
    },
  },
  layout: { selectPanel() {} },
}
await exportsObj.apply(ctx)

console.log('registrations:')
check('sidebar entry registered', collected.some((c) => c.options.name === 'sidebar.panellist'))
check('main panel registered', collected.some((c) => c.options.name === 'main'))
check(
  'sidebar id equals main key',
  collected.length === 2 && collected[0].options.id === collected[1].options.key,
)
console.log('')

/* ---------- 3. render every registered component through real React ---------- */
function render(entry) {
  const injected = typeof entry.options.inject === 'function' ? entry.options.inject() : {}
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(entry.component, Object.assign({ size: 18, t: (k) => k }, injected)),
  )
}

console.log('rendered output:')
const markup = {}
for (const entry of collected) {
  const key = entry.options.name
  try {
    markup[key] = render(entry)
    console.log('  ' + key + ' -> ' + markup[key].slice(0, 160) + (markup[key].length > 160 ? ' …' : ''))
  } catch (err) {
    console.log('  ' + key + ' -> THREW: ' + err.message)
    failures.push(key + ' render')
  }
}
console.log('')

/* ---------- 4. assertions on the markup: props landed, text survived ---------- */
const icon = markup['sidebar.panellist'] || ''
const page = markup['main'] || ''

console.log('icon component:')
check('is an <svg>', icon.startsWith('<svg'))
check('carries viewBox (props reached the element)', icon.includes('viewBox='))
check('carries stroke-width', icon.includes('stroke-width='))
check('no object leaked as text', !icon.includes('[object Object]'))

console.log('page component:')
check('root div rendered', page.includes('class="dsis-root"'))
check('title text present', page.includes('绘图工作站'))
check('"back to conversation" button text present', page.includes('切回对话'))
check('button is not an empty shell', !/<button[^>]*><\/button>/.test(page))
check('three column classes present', ['dsis-col-tags', 'dsis-col-main', 'dsis-col-side'].every((c) => page.includes(c)))
check('left pane is the spec view', page.includes('提示规范'))
check('middle pane copy present', page.includes('你想画什么'))
check('right pane copy present', page.includes('预设与成本'))
check('expand control present', page.includes('扩写提示词'))
check('no object leaked as text', !page.includes('[object Object]'))
check('no props object rendered as a child', !page.includes('onClick='))

console.log('')
if (failures.length === 0) {
  console.log('ALL CHECKS PASSED')
} else {
  console.log('FAILURES: ' + failures.join(' | '))
  process.exitCode = 1
}
