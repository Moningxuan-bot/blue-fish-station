/**
 * Trace what the bundle actually hands to React.createElement.
 *
 * The browser reports React error #31 (an object used as a child) for the sidebar icon,
 * but reading the source says the props object is routed to the props slot. This probe
 * stops arguing with the source: it swaps in a recording createElement and prints every
 * call, so the shape is observed rather than reasoned about.
 *
 * Usage: node probe-createelement.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let registration = null
const fakeWindow = { __ModuleLoader__: { load: (r) => { registration = r } } }
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  head: { appendChild() {} },
}

const ELEMENT = Symbol.for('react.element')
const calls = []

function createElement(type, props, ...children) {
  calls.push({
    type: typeof type === 'function' ? 'component:' + (type.name || 'anon') : String(type),
    props: props === null || props === undefined ? null : Object.keys(props),
    children: children.map((c) =>
      c === null
        ? 'null'
        : Array.isArray(c)
          ? 'array(' + c.length + ')'
          : typeof c === 'object' && c !== null
            ? c.$$typeof === ELEMENT
              ? 'element<' + (typeof c.type === 'function' ? c.type.name || 'anon' : c.type) + '>'
              : 'PLAIN OBJECT keys=' + JSON.stringify(Object.keys(c))
            : typeof c + ':' + String(c).slice(0, 24),
    ),
  })
  return { $$typeof: ELEMENT, type, props, children }
}

const REACT = {
  createElement,
  isValidElement: (v) => Boolean(v && typeof v === 'object' && v.$$typeof === ELEMENT),
  /**
   * 这个探针只关心 createElement 收到的参数形态，不关心状态，所以 hooks 用最小假实现。
   * 缺了它们，组件一进 useStation 就抛 `useState is not a function`，
   * 探针会把"mock 不全"误报成"组件坏了" —— 这是踩过的假警报。
   */
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}
const fakeRequire = (spec) => {
  if (spec === 'react') return REACT
  throw new Error('not in seed table: ' + spec)
}

new Function('require', 'window', 'document', readFileSync(join(here, 'lib', 'client.js'), 'utf8'))(
  fakeRequire,
  fakeWindow,
  fakeDocument,
)

const exportsObj = registration.factory(fakeRequire)
console.log('exports.inject =', JSON.stringify(exportsObj.inject))

/* Collect the components the bundle registers, then render each one. */
const collected = []
const ctx = {
  locale: { bind: () => (k) => k, register: () => () => {} },
  effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
  slots: {
    inject(key, cb) {
      const effect = cb()
      if (effect && typeof effect[Symbol.iterator] === 'function' && typeof effect !== 'function') {
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

for (const { options, component } of collected) {
  const label = options.name + ' ' + (options.key || options.id)
  console.log('\n=== rendering ' + label + ' ===')
  calls.length = 0
  try {
    const injected = typeof options.inject === 'function' ? options.inject() : {}
    component(Object.assign({ size: 18, t: (k) => k }, injected))
    for (const c of calls) {
      const flag = c.children.some((ch) => String(ch).startsWith('PLAIN OBJECT')) ? '   <-- PLAIN OBJECT PASSED AS CHILD' : ''
      console.log('  <' + c.type + '> props=' + JSON.stringify(c.props) + ' children=' + JSON.stringify(c.children) + flag)
    }
    const bad = calls.filter((c) => c.children.some((ch) => String(ch).startsWith('PLAIN OBJECT')))
    console.log(bad.length === 0 ? '  OK: no plain object reached a child slot' : '  BUG: ' + bad.length + ' call(s) passed a plain object as a child')
    if (bad.length > 0) process.exitCode = 1
  } catch (err) {
    console.error('  THREW ->', err && err.stack)
    process.exitCode = 1
  }
}
