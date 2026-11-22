import { expect, test } from 'claude-code/testing'
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { agyArgsModel, agyModelLabel, codexDefaultFrom, gather, isAgyPrint, readPs, rowsFor, scanner, span } from '../hooks/register'

const NOW = 1_800_000_000_000

const BAND = { plugin: 'codex-gemini-status', component: 'SessionMode', props: { modes: [] } } as const

const RUN = { command: 'cgstatus', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

/** ps の1行（pid 親pid 経過秒 引数）。 */
const L = (pid: number, ppid: number, age: number, args: string) => `  ${pid}  ${ppid}  ${age} ${args}`
const WRAPPER = (pid: number, age: number) => L(pid, 1, age, 'bash /home/me/bin/ask-codex.sh --stdin')
const CODEX = (pid: number, ppid: number, age: number, head = 'node /usr/bin/codex') =>
  L(pid, ppid, age, `${head} exec -C /home/me/work -s read-only -m gpt-5-codex -c model_reasoning_effort=medium 依頼の中の -m other は読まない`)
const AGY = (pid: number, ppid: number, age: number, head = 'agy') =>
  L(pid, ppid, age, `${head} -p お願い: 調べてください --sandbox --print-timeout 570s`)
const HUB = L(2068, 1, 899464, '/home/me/.gemini/bin/agy --hub --hub-port=33391 --app_data_dir=antigravity')

function install(on: On, ps: () => string, files: Record<string, string> = {}) {
  mock.env(on, { HOME: '/home/me' })
  mock.clock(on, { now: NOW })
  on('process.run', (_$, e) => (e.argv[0] === 'ps' ? { value: { exitCode: 0, stdout: ps(), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_$, e) => (files[e.path] !== undefined ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  // 本体（と、下にあるほかの mod）が描くもの
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>focus</Text>
  })
}

test('codex exec と agy -p を読み、モデルも拾う。ラッパーだけでは数えない', () => {
  const list = gather(readPs([WRAPPER(4001, 95), CODEX(4002, 4001, 94), AGY(4004, 1, 11)].join('\n')), NOW)
  expect(list.map(p => p.who)).toEqual(['Codex', 'Gemini'])
  expect(list[0]?.model).toBe('gpt-5-codex-medium')
  expect(list[0]?.ageSec).toBe(94)
  expect(list[1]?.ageSec).toBe(11)
  expect(readPs(WRAPPER(4001, 95))).toEqual([])
})

test('1回の起動の重なった処理（timeout・node・本体）は、親子関係で1本に数える', () => {
  const list = gather(readPs([CODEX(4300, 900, 90, 'timeout 1800 codex'), CODEX(4301, 4300, 90), CODEX(4302, 4301, 89, '/vendor/bin/codex')].join('\n')), NOW)
  expect(list.length).toBe(1)
  expect(list[0]?.count).toBe(1)
})

test('同時に始めた別々の起動は、時刻が同じでも2本に数える', () => {
  const ps = [AGY(7001, 900, 5, 'timeout 600 python3 /x/pty.py agy'), AGY(7002, 7001, 5), AGY(7100, 901, 5, 'timeout 120 /home/me/.gemini/bin/agy'), AGY(7101, 7100, 5, '/home/me/.gemini/bin/agy')]
  const list = gather(readPs(ps.join('\n')), NOW)
  expect(list.length).toBe(1)
  expect(list[0]?.count).toBe(2)
})

test('対話の画面・IDE の hub・codex app-server・bash -c の文字列は数えない', () => {
  const ps = [HUB, L(10, 1, 50, 'codex'), L(11, 1, 50, 'agy'), L(12, 1, 50, 'node /x/codex.js app-server --listen stdio://'), L(13, 1, 50, 'bash -c codex exec -m x 依頼')]
  expect(readPs(ps.join('\n'))).toEqual([])
  expect(isAgyPrint(['agy'])).toBe(false)
})

test('Gemini のモデル名は ID でも表示名でも同じ書き方にする', () => {
  expect(agyModelLabel('Gemini 4 Pro (High)')).toBe('gemini-4-pro-high')
  expect(agyModelLabel('gemini-4-pro-high')).toBe('gemini-4-pro-high')
  expect(agyModelLabel('')).toBe(null)
  expect(agyModelLabel(undefined)).toBe(null)
})

test('agy の正確な引数から --model を拾う。依頼文の中の --model は値にしない', () => {
  expect(agyArgsModel(['timeout', '600', 'python3', '/x/pty.py', 'agy', '-p', '依頼 --model x', '--model', 'Gemini 4 Pro (Low)', '--sandbox'])).toBe('gemini-4-pro-low')
  expect(agyArgsModel(['agy', '--model=gemini-4-flash-high', '-p', '依頼'])).toBe('gemini-4-flash-high')
  expect(agyArgsModel(['agy', '-p', '依頼'])).toBe(null)
})

test('Codex の既定モデルは config.toml の先頭（[表] の前）から読む', () => {
  expect(codexDefaultFrom('model = "gpt-5-codex"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "other"\n')).toEqual({ model: 'gpt-5-codex', effort: 'high' })
  expect(codexDefaultFrom('[profiles.x]\nmodel = "other"\n')).toEqual({ model: null, effort: null })
})

test('経過の表し方', () => {
  expect(span(29)).toBe('29秒')
  expect(span(185)).toBe('3分')
  expect(span(3900)).toBe('1時間5分')
})

test('rowsFor は、ps を読んでからの経過を足す', () => {
  const rows = rowsFor(gather(readPs(AGY(1, 900, 10)), NOW), NOW + 5_000)
  expect(Math.round(rows[0]?.sec ?? 0)).toBe(15)
})

test('動いているものを全部の画面で出す。/cgstatus hide で隠し、/cgstatus で戻る', async ($, on) => {
  install(on, () => CODEX(4002, 900, 94))
  const text = (await $.command.run({ ...RUN })).text ?? ''
  expect(text).toContain('Codex')
  expect(text).toContain('gpt-5-codex-medium')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Codex/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /focus/ })).toBeDefined()
    await ui.unmount()
  }

  await $.command.run({ ...RUN, args: 'hide' })
  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden.find({ type: 'Text', text: /Codex/ })).toBeUndefined()
  expect(await hidden.find({ type: 'Text', text: /focus/ })).toBeDefined()
  await hidden.unmount()

  await $.command.run({ ...RUN })
  const shown = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await shown.find({ type: 'Text', text: /Codex/ })).toBeDefined()
  await shown.unmount()
})

test('何も動いていなければ、何も足さない', async ($, on) => {
  install(on, () => HUB)
  expect((await $.command.run({ ...RUN })).text ?? '').toContain('動いていない')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Codex|Gemini/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /focus/ })).toBeDefined()
  await ui.unmount()
})

test('モデル名: 引数に指定があればそれ、無ければ設定ファイル（Codex は CODEX_HOME も見る）', async ($, on) => {
  mock.env(on, { HOME: '/home/me', CODEX_HOME: '/opt/codex' })
  mock.clock(on, { now: NOW })
  const ps = [L(5, 900, 3, 'codex exec -'), AGY(6, 900, 3), AGY(8, 901, 3)]
  const agyArgv = (model: string[]) => ['agy', '-p', 'お願い', ...model].join('\0') + '\0'
  on('process.run', () => ({ value: { exitCode: 0, stdout: ps.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const files: Record<string, string> = {
    '/opt/codex/config.toml': 'model = "gpt-5-codex"\n',
    '/home/me/.gemini/antigravity-cli/settings.json': JSON.stringify({ model: 'Gemini 4 Pro (High)' }),
    '/proc/6/cmdline': agyArgv(['--model', 'Gemini 4 Flash (Low)']),
  }
  on('fs.read', (_$, e) => (files[e.path] !== undefined ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  const text = (await $.command.run({ ...RUN })).text ?? ''
  expect(text).toContain('● Codex 作業中 3秒 gpt-5-codex')
  // Gemini は2本。引数で指定した方のモデルを出す
  expect(text).toContain('● Gemini 作業中 3秒 ×2 gemini-4-flash-low')
})

test('設定ファイルも読めなければ、モデル名なしで出す', async ($, on) => {
  install(on, () => AGY(6, 900, 3))
  const text = (await $.command.run({ ...RUN })).text ?? ''
  expect(text).toContain('● Gemini 作業中 3秒')
  expect(text).not.toContain('gemini-')
})

test('Codex: 推論の強さだけを引数で上書きした時は、設定ファイルのモデルに引数の強さを付ける', async ($, on) => {
  install(on, () => L(5, 900, 3, 'codex exec -c model_reasoning_effort=low -'), { '/home/me/.codex/config.toml': 'model = "gpt-5-codex"\nmodel_reasoning_effort = "high"\n' })
  expect((await $.command.run({ ...RUN })).text ?? '').toContain('● Codex 作業中 3秒 gpt-5-codex-low')
})

test('光の粒は1個でも壊れない', () => {
  expect(scanner(1, 7)).toEqual([{ on: true, glow: 1 }])
  expect(scanner(6, 0)[0]?.on).toBe(true)
})
