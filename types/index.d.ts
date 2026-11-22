/** ps で見つけた、動いている CLI（Codex か Gemini）。同じ CLI の処理は1つにまとめる。 */
export type CodexGeminiPeer = {
  who: string
  /** ps を読んだ時点の経過秒（一番長く動いている処理）。 */
  ageSec: number
  /** ps を読んだ時刻（ミリ秒）。 */
  seenAt: number
  /** 同時に動いている本数（1なら表示しない）。 */
  count: number
  /** モデル名（分からなければ無し）。 */
  model?: string
  /** モデルを指定せず推論の強さだけを引数で上書きした Codex の、その強さ（設定ファイルのモデルと組み合わせる）。 */
  effort?: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-gemini-status': { peers: CodexGeminiPeer[]; fx: number; isHidden: boolean }
  }
}
