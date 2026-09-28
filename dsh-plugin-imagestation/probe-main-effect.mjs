/**
 * Focused probe: does the `ctx.slots.inject('main', function* () { ... })` effect
 * actually reach the register call?
 *
 * The first probe's mock ran the callback but never consumed the returned generator,
 * so a mistake inside it could hide. This one advances the generator explicitly and
 * reports exactly what it yields.
 *
 * Usage: node probe-main-effect.mjs
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
function createElement(type, props, ...children) {
  return { $$typeof: Symbol.for('react.element'), type, props, children }
}
const SEED = {
  react: {
    createElement,
    isValidElement: (v) => Boolean(v && v.$$typeof === Symbol.for('react.element')),
  },
}
const fakeRequire = (spec) => {
  if (SEED[spec]) return SEED[spec]
  throw new Error('not in seed table: ' + spec)
}

new Function('require', 'window', 'document', readFileSync(join(here, 'lib', 'client.js'), 'utf8'))(
  fakeRequire,
  fakeWindow,
  fakeDocument,
)

const exportsObj = registration.factory(fakeRequire)

/** Mirror the documented behaviour: when the key is already declared the callback runs now. */
const effects = {}
const ctx = {
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: {
    inject(key, cb) {
      effects[key] = cb()
      return () => {}
    },
    register(options, component) {
      console.log('  register called:', JSON.stringify({ name: options.name, key: options.key, id: options.id }))
      return () => {}
    },
  },
  layout: { selectPanel() {} },
}

await exportsObj.apply(ctx)

console.log('effects captured for keys:', Object.keys(effects).join(', '))

for (const [key, effect] of Object.entries(effects)) {
  console.log('\n--- consuming effect for "' + key + '" ---')
  console.log('  typeof:', typeof effect)
  const isIterable = effect !== null && typeof effect === 'object' && Symbol.iterator in effect
  console.log('  iterable:', isIterable)
  try {
    if (typeof effect === 'function') {
      const disposer = effect()
      console.log('  called as function -> returned', typeof disposer)
    } else if (isIterable) {
      const items = [...effect]
      console.log('  iterated -> yielded', items.length, 'item(s):', items.map((i) => typeof i).join(', '))
    } else {
      console.log('  NOTHING CONSUMABLE — the registration can never happen')
    }
  } catch (err) {
    console.error('  THREW while consuming ->', err && err.stack)
    process.exitCode = 1
  }
}
