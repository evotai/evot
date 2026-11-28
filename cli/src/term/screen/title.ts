export class TerminalTitle {
  private frozen = false
  private suffix: string | undefined

  constructor(
    private readonly cwd: string,
    private readonly port: () => number | null,
    private readonly gatewayLabel: () => string | null = () => null,
  ) {}

  set(suffix?: string, force = false): void {
    if (this.frozen && !force) return
    this.write(suffix)
  }

  freeze(suffix?: string): void {
    this.write(suffix)
    this.frozen = true
  }

  unfreeze(): void {
    this.frozen = false
  }

  /** Refresh ownership information without replacing a frozen activity indicator. */
  refresh(): void {
    this.write(this.suffix)
  }

  private write(suffix?: string): void {
    this.suffix = suffix
    const dirName = this.cwd.split('/').pop() || this.cwd
    const base = `evot - ${dirName}`
    const port = this.port()
    const service = this.gatewayLabel() ?? (port ? `:${port}` : '')
    const title = `${suffix ? `${suffix} ` : ''}${base}${service ? ` · ${service}` : ''}`
    process.stdout.write(`\x1b]0;${title}\x07`)
  }
}
