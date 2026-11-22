import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CodexGeminiPeer } from '../types'

// codex-gemini-status: Codex CLI と Antigravity CLI（Gemini）が「いまモデルを動かしているか」を、
// Claude Code の入力欄の右下（ステータス行の右端）に1人1行で出す mod。
//
// - 動いているかは ps で読む。見るのは本体のワンショット（codex exec / agy -p）だけ。
//   どのラッパー・スクリプト・ターミナルから起動しても、中の本体が見えるので同じに数える。
//   対話の画面（codex / agy を引数なしで開いたもの）と、IDE が常に動かしている agy --hub、
//   codex app-server は数えない（開いている間ずっと出っぱなしになり、考えているかどうかを ps では見分けられないため）。
// - 1回の起動が timeout → node / python → 本体 のように重なった処理で動いても、ps の親子関係で1本に数える。
//   同時に始めた別々の起動は、時刻が同じでも別に数える。
// - モデル名は「起動時の引数 → 無ければ設定ファイル」の順:
//   Codex  … codex exec の -m / -c model=… / -c model_reasoning_effort=…、無ければ $CODEX_HOME/config.toml（既定 ~/.codex）
//   Gemini … agy の --model（/proc/<pid>/cmdline の正確な引数から。表示名は空白を含むため）、無ければ ~/.gemini/antigravity-cli/settings.json
// - 依頼文（プロンプト）は表示も保存もしない（ps や /proc の引数に含まれていれば、モデル名を探す間だけ読む）。ファイルへの書き込みもしない。
// - Linux（WSL2 を含む）向け。ps の etimes と /proc を使う。

const peers = atom({ plugin: 'codex-gemini-status', key: 'peers' } as const, [])
/** 光のコマ。動いているものがある間だけ、いまの時刻（ミリ秒）で更新する。 */
const fx = atom({ plugin: 'codex-gemini-status', key: 'fx' } as const, 0)
const isHidden = atom({ plugin: 'codex-gemini-status', key: 'isHidden' } as const, false)

const SCAN_MS = 5_000
const FRAME_MS = 120

type Who = 'Codex' | 'Gemini'
const WHO: Who[] = ['Codex', 'Gemini']

/** 経過の表し方（29秒・3分・1時間5分）。 */
export function span(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))}秒`
  if (sec < 3600) return `${Math.floor(sec / 60)}分`
  return `${Math.floor(sec / 3600)}時間${Math.floor((sec % 3600) / 60)}分`
}

/** 端末での幅（全角は2桁）。 */
export function width(text: string): number {
  let n = 0
  for (const ch of text) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return n
}

// ── ps から、動いている本体を読む ──

/** 値を1つ取る codex exec のオプション（依頼文との境目を見分けるため）。 */
const CODEX_VALUE_FLAGS = new Set(['-s', '--sandbox', '-C', '--cd', '-i', '--image', '-p', '--profile', '-o', '--output-last-message', '--output-schema', '--color', '--local-provider', '--enable', '--disable', '--add-dir'])

/** モデルの表示名（例 gpt-5-codex-high）。推論の強さが分からなければモデル名だけ。 */
export function modelLabel(model: string | null | undefined, effort: string | null | undefined): string | null {
  if (!model) return null
  return effort ? `${model}-${effort}` : model
}

/**
 * codex exec の引数から、モデルと推論の強さを拾う。
 * codex 本体（node 経由・timeout の後ろも可）の直後が exec のものだけ。bash -c "…codex…exec…" のような文字列や、依頼文の中の -m は読まない。
 */
export function codexArgs(argv: string[]): { model: string | null; effort: string | null } | null {
  const base = (x: string) => x.split('/').pop() ?? ''
  const at = argv.findIndex(a => base(a) === 'codex')
  if (at < 0 || at > 3 || argv[at + 1] !== 'exec' || argv.slice(0, at).includes('-c')) return null
  const unq = (t: string) => t.replace(/^["']|["']$/g, '')
  let model: string | null = null
  let effort: string | null = null
  const kv = (text: string) => {
    const m = /^(model|model_reasoning_effort)=(.+)$/.exec(text)
    if (m?.[1] === 'model') model = unq(m[2]!)
    else if (m?.[1] === 'model_reasoning_effort') effort = unq(m[2]!)
  }
  for (let i = at + 2; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-m' || a === '--model') { if (argv[i + 1] !== undefined) model = unq(argv[++i]!); continue }
    if (a === '-c' || a === '--config') { if (argv[i + 1] !== undefined) kv(argv[++i]!); continue }
    if (a.startsWith('--model=')) { model = unq(a.slice(8)); continue }
    if (a.startsWith('--config=')) { kv(a.slice(9)); continue }
    if (CODEX_VALUE_FLAGS.has(a)) { i++; continue }
    if (a.startsWith('-')) continue
    break
  }
  return { model, effort }
}

/**
 * agy のワンショット（-p / --print / --prompt）か。対話や IDE の hub（--hub）は数えない。
 * ラッパーが timeout → python3 → agy と重ねて呼ぶこともあるので、agy の位置は先頭から4つ目まで見る。
 */
export function isAgyPrint(argv: string[]): boolean {
  const base = (x: string) => x.split('/').pop() ?? ''
  const at = argv.findIndex(a => base(a) === 'agy')
  if (at < 0 || at > 4) return false
  const rest = argv.slice(at + 1)
  return !rest.includes('--hub') && rest.some(a => a === '-p' || a === '--print' || a === '--prompt')
}

/** agy のモデル名（ID の gemini-4-pro-high でも、表示名の Gemini 4 Pro (High) でも）を、同じ書き方（gemini-4-pro-high）にする。 */
export function agyModelLabel(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null
  const label = name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
  return label === '' ? null : label
}

/**
 * agy の正確な引数（/proc/<pid>/cmdline を NUL で分けたもの）から、--model の値を拾う。
 * agy の表示名は空白を含み、ps の args を空白で区切ると境目が分からないので、ここには正確な引数だけを渡す。
 */
export function agyArgsModel(argv: readonly string[]): string | null {
  const base = (x: string) => x.split('/').pop() ?? ''
  const at = argv.findIndex(a => base(a) === 'agy')
  if (at < 0 || at > 4) return null
  for (let i = at + 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--model' || a === '-model') return agyModelLabel(argv[i + 1])
    const eq = /^--?model=(.*)$/s.exec(a)
    if (eq) return agyModelLabel(eq[1])
  }
  return null
}

/** model は表示するモデル名。effort は、モデルは指定せず推論の強さだけを引数で上書きした Codex の、その強さ（モデルは設定ファイルから補う）。 */
type Seen = { who: Who; ageSec: number; model?: string; effort?: string }
type Proc = { who: Who; age: number; model: string | null; effort: string | null }

/**
 * ps の1行（pid 親pid 経過秒 引数）から、モデルが動いている印を拾う。
 * 先祖に同じ CLI の本体がいるもの（timeout → node / python → 本体 の重なり）は数えない。モデルは一番外側の処理の引数から取る。
 */
export function readPs(stdout: string, exactArgv: ReadonlyMap<number, readonly string[]> = new Map()): Seen[] {
  const parent = new Map<number, number>()
  const procs = new Map<number, Proc>()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const age = Number(m[3])
    const argv = m[4]!.split(/\s+/)
    parent.set(pid, Number(m[2]))
    const cx = codexArgs(argv)
    if (cx) { procs.set(pid, { who: 'Codex', age, model: modelLabel(cx.model, cx.effort), effort: cx.model === null ? cx.effort : null }); continue }
    if (isAgyPrint(argv)) {
      const exact = exactArgv.get(pid)
      procs.set(pid, { who: 'Gemini', age, model: exact === undefined ? null : agyArgsModel(exact), effort: null })
    }
  }
  /** 親から順に先祖の pid（init まで。輪になっていても止まる）。 */
  const ancestors = (pid: number): number[] => {
    const up: number[] = []
    for (let at = parent.get(pid); at !== undefined && at > 1 && !up.includes(at) && up.length < 64; at = parent.get(at)) up.push(at)
    return up
  }
  const found: Seen[] = []
  for (const [pid, p] of procs) {
    if (ancestors(pid).some(a => procs.get(a)?.who === p.who)) continue
    found.push({ who: p.who, ageSec: p.age, ...(p.model === null ? {} : { model: p.model }), ...(p.effort === null ? {} : { effort: p.effort }) })
  }
  return found
}

/** CLI ごとにまとめる: いちばん長く動いているものの時間と、同時に動いている本数。 */
export function gather(found: readonly Seen[], seenAt: number): CodexGeminiPeer[] {
  return WHO.flatMap(who => {
    const mine = found.filter(f => f.who === who).sort((a, b) => b.ageSec - a.ageSec)
    const top = mine[0]
    if (top === undefined) return []
    const named = mine.find(f => f.model !== undefined)
    const effort = mine.find(f => f.effort !== undefined)?.effort
    return [{ who, ageSec: top.ageSec, seenAt, count: mine.length, ...(named?.model === undefined ? (effort === undefined ? {} : { effort }) : { model: named.model }) }]
  })
}

/** Codex の config.toml の先頭（[表] の前）にある既定のモデルと推論の強さ。-m や -c を渡さない時はこれが使われる。 */
export function codexDefaultFrom(toml: string): { model: string | null; effort: string | null } {
  const lines: string[] = []
  for (const line of toml.split('\n')) {
    if (/^\s*\[\[?\s*[A-Za-z_"'][^\]]*\]\]?\s*(#.*)?$/.test(line)) break
    lines.push(line)
  }
  const top = lines.join('\n')
  const pick = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(top)?.[1] ?? null
  return { model: pick('model'), effort: pick('model_reasoning_effort') }
}

async function codexDefault($: EngineInterface): Promise<{ model: string | null; effort: string | null } | null> {
  const codexHome = (await $.env.get('CODEX_HOME')) ?? ((h => (h === undefined ? undefined : `${h}/.codex`))(await $.env.get('HOME')))
  if (codexHome === undefined) return null
  try {
    return codexDefaultFrom(await $.fs.read(`${codexHome}/config.toml`))
  } catch {
    return null
  }
}

/** Antigravity CLI の settings.json の既定のモデル。agy に --model を渡さない時はこれが使われる。 */
async function agyDefault($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  if (home === undefined) return null
  try {
    const conf: unknown = JSON.parse(await $.fs.read(`${home}/.gemini/antigravity-cli/settings.json`))
    return agyModelLabel(conf !== null && typeof conf === 'object' ? (conf as { model?: unknown }).model as string | undefined : null)
  } catch {
    return null
  }
}

/** ps に出た agy のワンショットについて、/proc/<pid>/cmdline から正確な引数を読む（読めなかったものは入れない）。 */
async function agyExactArgv($: EngineInterface, stdout: string): Promise<Map<number, string[]>> {
  const exact = new Map<number, string[]>()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+\d+\s+\d+\s+(.*)$/.exec(line)
    if (!m || !isAgyPrint(m[2]!.split(/\s+/))) continue
    try {
      const raw = await $.fs.read(`/proc/${m[1]}/cmdline`)
      exact.set(Number(m[1]), raw.split('\0').filter((a, i, all) => i < all.length - 1 || a !== ''))
    } catch {
      // 終わった直後などで読めなければ、settings.json の既定に任せる
    }
  }
  return exact
}

async function scan($: EngineInterface): Promise<CodexGeminiPeer[]> {
  const ps = await $.process.run(['ps', '-eo', 'pid=,ppid=,etimes=,args='], { timeoutMs: 5_000 }).catch(() => null)
  const stdout = ps?.stdout ?? ''
  let list = gather(readPs(stdout, await agyExactArgv($, stdout)), await $.clock.now())
  const fill = async (who: Who, get: (p: CodexGeminiPeer) => Promise<string | null>) => {
    const at = list.findIndex(p => p.who === who && p.model === undefined)
    if (at < 0) return
    const label = await get(list[at]!)
    const { effort: _drop, ...rest } = list[at]!
    list = list.map((p, i) => (i === at ? (label === null ? rest : { ...rest, model: label }) : p))
  }
  // Codex: モデルは設定ファイルから。推論の強さは、引数で上書きしていればそれ、無ければ設定ファイルから
  await fill('Codex', async p => {
    const def = await codexDefault($)
    return modelLabel(def?.model, p.effort ?? def?.effort)
  })
  await fill('Gemini', () => agyDefault($))
  return list
}

// ── 表示する行 ──

type Row = { who: string; sec: number; model?: string; count: number }

/** いま出す行（動いているものだけ、CLI ごとに1行）。 */
export function rowsFor(found: readonly CodexGeminiPeer[], nowMs: number): Row[] {
  return found.map(p => ({ who: p.who, sec: p.ageSec + Math.max(0, nowMs - p.seenAt) / 1000, count: p.count, ...(p.model === undefined ? {} : { model: p.model }) }))
}

const NAME_BLUE = '#82aaff'
const LABEL_GRAY = '#7f848e'
const VALUE = '#d8dde3'
const DIVIDER = '#4b5263'
const DIM_BLOCK = '#353b45'
const RUNNING = '#7fd6c2'

/** 2色の間の色（t は 0〜1）。 */
function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

/** 光の粒が左右に行き来する（終わりの見えない仕事）。 */
export function scanner(n: number, frame: number): { on: boolean; glow: number }[] {
  if (n <= 1) return Array.from({ length: Math.max(0, n) }, () => ({ on: true, glow: 1 }))
  const span2 = (n - 1) * 2
  const t = frame % span2
  const at = t < n ? t : span2 - t
  return Array.from({ length: n }, (_, i) => ({ on: i === at, glow: Math.max(0, 1 - Math.abs(i - at) / 2.5) }))
}

export const register: Register = on => {
  let frameTimer: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cgstatus',
      description: 'Codex・Gemini が動いているかの表示。/cgstatus で状況を文字で返して表示を戻す。/cgstatus hide で表示を隠す',
      immediate: true,
    })
    const refresh = async () => {
      const list = await scan($)
      await update($, peers, () => list)
    }
    await refresh().catch(() => undefined)
    $.clock.every(SCAN_MS, () => void refresh().catch(() => undefined))
    // 光のコマ。動いているものがある間だけ毎コマ更新する
    frameTimer ??= $.clock.every(FRAME_MS, () => {
      void (async () => {
        if (await read($, isHidden)) return
        if ((await read($, peers)).length === 0) return
        const t = await $.clock.now()
        await update($, fx, () => t)
      })().catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'cgstatus' }, async ($, e) => {
    // 普通の画面の端末はクリックを渡さないので、隠す・戻すはコマンドで
    if (/^\s*(hide|off)\s*$/i.test(e.args)) {
      await update($, isHidden, () => true)
      return { text: '表示を隠したよ。/cgstatus でまた出る。' }
    }
    const list = await scan($)
    await update($, peers, () => list)
    await update($, isHidden, () => false)
    const rows = rowsFor(list, await $.clock.now())
    if (rows.length === 0) return { text: 'Codex も Gemini も、いまは動いていないよ。' }
    return { text: rows.map(r => `● ${r.who} 作業中 ${span(r.sec)}${r.count > 1 ? ` ×${r.count}` : ''}${r.model ? ` ${r.model}` : ''}`).join('\n') }
  })

  // 入力欄の右下（ステータス行の右端＝SessionMode）。動いているものだけ1行ずつ足す。
  // もともとの表示（本体や下にあるほかの mod が描いたもの）は、そのまま1行目に残す。
  //   │ Codex : 作業中 29秒 gpt-5-codex-high ▮▮▯▯▯▯
  // 何も動いていなければ何も足さない
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const original = await next(e)
    if (await read($, isHidden)) return original
    const frameMs = await read($, fx)
    const rows = rowsFor(await read($, peers), frameMs)
    if (rows.length === 0) return original

    const { Box, Text } = $.ui.resolve(e)
    const frame = Math.floor(frameMs / FRAME_MS)
    type Part = { text: string; color: string; bg?: string }
    const P = (text: string, color: string, bg?: string): Part => ({ text, color, bg })
    const lines = rows.map((r): Part[] => {
      const parts: Part[] = [P(r.who, NAME_BLUE), P(' : ', DIVIDER), P(' 作業中 ', RUNNING, mix('#1e1e1e', RUNNING, 0.14)), P(' ', LABEL_GRAY), P(span(r.sec), VALUE)]
      if (r.count > 1) parts.push(P(` ×${r.count}`, LABEL_GRAY))
      if (r.model) parts.push(P(' ' + r.model, VALUE))
      parts.push(P(' ', LABEL_GRAY))
      for (const c of scanner(6, frame)) parts.push(P('▮', c.on ? RUNNING : c.glow > 0 ? mix(DIM_BLOCK, RUNNING, c.glow) : DIM_BLOCK))
      return parts
    })
    const widest = Math.max(...lines.map(l => l.reduce((n, p) => n + width(p.text), 0)))
    return (
      <Box flexDirection="column" alignItems="flex-end">
        {original}
        {lines.map((parts, i) => (
          <Box key={`r${i}`} flexDirection="row" flexShrink={0}>
            <Text color={DIVIDER}>{'│ '}</Text>
            {parts.map((p, j) => <Text key={`p${j}`} color={p.color} backgroundColor={p.bg}>{p.text}</Text>)}
            <Text>{' '.repeat(widest - parts.reduce((n, p) => n + width(p.text), 0))}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
