import test from 'brittle'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import { analyze } from '../src/core/analyzer.js'
import { loadConfig } from '../src/config/loader.js'
import { loadPlugins } from '../src/config/plugins.js'
import { builtInRules } from '../src/rules/index.js'

const RULE_NAME = 'opts/echo'
const DEFAULTS_RULE_NAME = 'opts/echo-defaults'
const MUTATE_RULE_NAME = 'opts/mutate'

const PLUGIN_SOURCE = `
function echo(name, defaultOptions) {
  return {
    meta: { name, defaultOptions },
    create(context) {
      return {
        Program(node) {
          context.report({ node, message: JSON.stringify(context.options ?? null) })
        }
      }
    }
  }
}

const MUTATE_DEFAULTS = { count: 0, pattern: /a/g }

function mutate(name) {
  return {
    meta: { name, defaultOptions: [MUTATE_DEFAULTS] },
    create(context) {
      return {
        Program(node) {
          const options = context.options[0]
          options.count++
          const matched = options.pattern ? options.pattern.test('aaa') : null
          context.report({ node, message: JSON.stringify({ count: options.count, matched }) })
        }
      }
    }
  }
}

export { MUTATE_DEFAULTS }

export default {
  rules: [
    echo('${RULE_NAME}'),
    echo('${DEFAULTS_RULE_NAME}', [{ max: 40 }]),
    mutate('${MUTATE_RULE_NAME}')
  ]
}
`

test('plugin rules receive options from .lunterc', async (t) => {
  const dir = await setup(t, {
    rules: {
      [RULE_NAME]: ['warn', { max: 60 }, 'strict'],
      [DEFAULTS_RULE_NAME]: ['error', { max: 80 }]
    }
  })

  const echoed = await lint(dir)

  t.alike(echoed.get(RULE_NAME), { severity: 'warning', options: [{ max: 60 }, 'strict'] })
  t.alike(echoed.get(DEFAULTS_RULE_NAME), { severity: 'error', options: [{ max: 80 }] })
})

test('context.options falls back to meta.defaultOptions, then []', async (t) => {
  const dir = await setup(t, {
    rules: { [RULE_NAME]: 'error', [DEFAULTS_RULE_NAME]: 'warn' }
  })

  const echoed = await lint(dir)

  t.alike(echoed.get(RULE_NAME), { severity: 'error', options: [] })
  t.alike(echoed.get(DEFAULTS_RULE_NAME), { severity: 'warning', options: [{ max: 40 }] })
})

test('a CLI severity override keeps options from .lunterc', async (t) => {
  const dir = await setup(t, { rules: { [RULE_NAME]: ['error', { max: 60 }] } })

  const echoed = await lint(dir, [{ name: RULE_NAME, severity: 'warn' }])

  t.alike(echoed.get(RULE_NAME), { severity: 'warning', options: [{ max: 60 }] })
})

test('each file gets its own copy of context.options', async (t) => {
  const configured = await setup(t, { rules: { [MUTATE_RULE_NAME]: ['error', { count: 5 }] } })
  const defaulted = await setup(t, { rules: { [MUTATE_RULE_NAME]: 'error' } })

  for (let run = 0; run < 3; run++) {
    const fromConfig = await lint(configured)
    const fromDefaults = await lint(defaulted)

    t.alike(
      fromConfig.get(MUTATE_RULE_NAME).options,
      { count: 6, matched: null },
      `config, run ${run}`
    )
    t.alike(
      fromDefaults.get(MUTATE_RULE_NAME).options,
      { count: 1, matched: true },
      `defaults, run ${run}`
    )
  }

  const { MUTATE_DEFAULTS } = await import(pathToFileURL(join(defaulted, 'plugin.mjs')).href)
  t.is(MUTATE_DEFAULTS.count, 0, "the plugin's own defaults are untouched")
  t.is(MUTATE_DEFAULTS.pattern.lastIndex, 0, 'and so is its regex')
  t.execution(() => {
    MUTATE_DEFAULTS.count = 0
  }, 'and they stay writable')
})

async function setup(t, lunterc) {
  const dir = await mkdtemp(join(tmpdir(), 'lunte-rule-options-'))
  const pluginPath = join(dir, 'plugin.mjs')
  await writeFile(pluginPath, PLUGIN_SOURCE)
  await writeFile(join(dir, '.lunterc'), JSON.stringify({ plugins: [pluginPath], ...lunterc }))

  t.teardown(() => {
    builtInRules.delete(RULE_NAME)
    builtInRules.delete(DEFAULTS_RULE_NAME)
    builtInRules.delete(MUTATE_RULE_NAME)
  })

  return dir
}

async function lint(dir, cliOverrides = []) {
  const { config } = await loadConfig({ cwd: dir })
  await loadPlugins(config.plugins, { cwd: dir })

  const ruleOverrides = Object.entries(config.rules).map(([name, severity]) => ({
    name,
    severity
  }))
  const { diagnostics } = await analyze({
    source: 'export {}\n',
    sourceFile: join(dir, 'input.js'),
    ruleOverrides: [...ruleOverrides, ...cliOverrides]
  })

  const echoed = new Map()
  for (const { ruleId, severity, message } of diagnostics) {
    if (ruleId?.startsWith('opts/')) {
      echoed.set(ruleId, { severity, options: JSON.parse(message) })
    }
  }
  return echoed
}
