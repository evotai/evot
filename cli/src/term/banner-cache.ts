import chalk from 'chalk'
import { getTheme } from '../render/theme/index.js'
import { loadBannerData, renderBanner, type BannerData, type BannerOptions } from './banner.js'

/** Per-REPL cache: disk refreshes are explicit; rendering only consumes a snapshot. */
export class BannerCache {
  private data: BannerData
  private dataKey: string
  private frameKey: string | null = null
  private theme = getTheme()
  private text = ''

  constructor(
    cwd: string,
    skillsDirs: string[],
    private readonly load = loadBannerData,
    private readonly paint = renderBanner,
  ) {
    this.data = load(cwd, skillsDirs)
    this.dataKey = JSON.stringify(this.data)
  }

  /** Returns true only when a disk change requires a repaint. */
  refresh(cwd: string, skillsDirs: string[]): boolean {
    const data = this.load(cwd, skillsDirs)
    const key = JSON.stringify(data)
    if (key === this.dataKey) return false
    this.data = data
    this.dataKey = key
    this.frameKey = null
    return true
  }

  render(opts: BannerOptions): string {
    // Key by displayed values rather than ConfigInfo identity: cloud sync may
    // replace that object with equivalent data, or update it in place.
    const key = JSON.stringify([
      opts.version, opts.columns, opts.rows, opts.quiet,
      opts.configInfo !== undefined, opts.configInfo?.hasApiKey,
      opts.serverState?.address, opts.releaseNotes, opts.installDrift, opts.startupWarning, chalk.level,
    ])
    const theme = getTheme()
    if (this.frameKey !== key || this.theme !== theme) {
      this.text = this.paint(opts, this.data)
      this.frameKey = key
      this.theme = theme
    }
    return this.text
  }
}
