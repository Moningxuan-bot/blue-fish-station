/**
 * Headless probe for the drawing-station client bundle.
 *
 * Reproduces what the browser does: a require() backed by a fake platform seed table,
 * a minimal DOM stub, and a recording ctx — then runs the bundle's apply() so any
 * exception surfaces with a real stack, instead of the browser's "entry did not activate".
 *
 * Usage: node probe-client.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/* ---------- 1. capture what the bundle registers ---------- */
let registration = null
const fakeWindow = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}

/* ---------- 2. minimal DOM for the style-injection path ---------- */
const appended = []
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  head: { appendChild: (el) => appended.push(el) },
}

/* ---------- 3. fake platform seed table ---------- */
function createElement(type, props, ...children) {
  return { $$typeof: Symbol.for('react.element'), type, props, children }
}
const REACT = {
  createElement,
  isValidElement: (v) => Boolean(v && v.$$typeof === Symbol.for('react.element')),
}
const SEED = {
  react: REACT,
  'react/jsx-runtime': { jsx: createElement, jsxs: createElement },
}
const missingRequests = []
function fakeRequire(spec) {
  if (Object.prototype.hasOwnProperty.call(SEED, spec)) return SEED[spec]
  missingRequests.push(spec)
  throw new Error('probe: require("' + spec + '") is not in the platform seed table')
}

/* ---------- 4. load the bundle (it is a script, not a module) ---------- */
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
new Function('require', 'window', 'document', source)(fakeRequire, fakeWindow, fakeDocument)

if (registration === null) {
  console.error('FAIL: the bundle never called window.__ModuleLoader__.load')
  process.exit(1)
}
console.log('registered id:', registration.id)
console.log('factory type :', typeof registration.factory)

/* ---------- 5. run the factory ---------- */
let exportsObj
try {
  exportsObj = registration.factory(fakeRequire)
} catch (err) {
  console.error('FAIL: factory threw ->', err && err.stack)
  process.exit(1)
}
console.log('exports keys :', Object.keys(exportsObj).join(', '))
console.log('missing require targets:', missingRequests.length === 0 ? 'none' : missingRequests.join(', '))

/* ---------- 6. recording ctx, mirroring the documented service shapes ---------- */
const calls = []
function makeCtx() {
  return {
    locale: {
      register(ns, locale, dict) {
        calls.push(['locale.register', ns, locale, Object.keys(dict).length])
        return () => {}
      },
      bind(ns) {
        calls.push(['locale.bind', ns])
        return (key) => '[' + key + ']'
      },
    },
    slots: {
      inject(key, cb) {
        calls.push(['slots.inject', key])
        let effect
        try {
          effect = cb()
        } catch (err) {
          calls.push(['slots.inject.THREW', key, err && err.message])
          throw err
        }
        calls.push(['slots.inject.effect', key, typeof effect])
        return () => {}
      },
      register(options, component) {
        calls.push(['slots.register', options.name, options.key || options.id, typeof component])
        return () => {}
      },
    },
    layout: {
      selectPanel(id) {
        calls.push(['layout.selectPanel', String(id)])
      },
    },
  }
}

try {
  const out = exportsObj.apply(makeCtx())
  if (out && typeof out.then === 'function') {
    await out
    calls.push(['apply resolved (async)'])
  } else {
    calls.push(['apply returned synchronously'])
  }
} catch (err) {
  console.error('\nFAIL: apply() threw ->', err && err.stack)
  console.error('\ncalls before the throw:')
  for (const c of calls) console.error('   ', JSON.stringify(c))
  process.exit(1)
}

console.log('\napply() completed. calls:')
for (const c of calls) console.log('   ', JSON.stringify(c))

/* ---------- 7. render every component the bundle registered ---------- */
const collected = []
const ctx2 = makeCtx()
ctx2.slots.register = (options, component) => {
  collected.push({ options, component })
  return () => {}
}
await exportsObj.apply(ctx2)

console.log('\nrender smoke test:')
for (const { options, component } of collected) {
  try {
    const injected = typeof options.inject === 'function' ? options.inject() : {}
    const props = Object.assign({ size: 18, t: (k) => k }, injected)
    const tree = component(props)
    console.log('   ok   ', options.name, options.key || options.id, '-> root <' + (tree && tree.type) + '>')
  } catch (err) {
    console.error('   FAIL ', options.name, options.key || options.id, '->', err && err.message)
    console.error('        ', err && err.stack)
    process.exitCode = 1
  }
}

/* ---------- 8. exercise the switch-back action ---------- */
console.log('\ninteraction smoke test:')
const ctx3 = makeCtx()
let backAction = null
ctx3.slots.register = (options, component) => {
  if (typeof options.inject === 'function') backAction = options.inject()
  return () => {}
}
await exportsObj.apply(ctx3)
try {
  if (backAction && typeof backAction.stationBack === 'function') {
    backAction.stationBack()
    console.log('   ok    stationBack() invoked -> selectPanel(null) recorded above')
  } else {
    console.log('   note  no stationBack injected (panel registers none, or shape changed)')
  }
} catch (err) {
  console.error('   FAIL  stationBack ->', err && err.message)
  process.exitCode = 1
}
