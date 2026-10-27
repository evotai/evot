import type { Agent } from './native/index.js'

export interface CliOptions {
  command: 'repl' | 'serve' | 'prompt' | 'update' | 'login' | 'logout' | 'whoami' | 'acp'
  model?: string
  prompt?: string
  port?: number
  resume?: string
  continueLatest: boolean
  /** `--fork [id]`: start in a fresh fork of `id`, or of the latest session in cwd. */
  fork?: { sessionId?: string }
  envFile?: string
  outputFormat: 'text' | 'stream-json'
  maxTurns: number
  maxTokens: number
  maxDuration: number
  appendSystemPrompt?: string
  skillsDirs: string[]
  skillNames: string[]
  files: string[]
  /** `evot acp --tools`: tools ACP sessions may use. */
  acpTools: 'full' | 'readonly' | 'none'
  /** `evot acp --permission`: ask the client before every tool call, or not. */
  acpPermission: 'ask' | 'allow'
  /** `evot acp --ephemeral`: keep ACP sessions in memory only. */
  ephemeral: boolean
}

export async function parseArgs(argv: string[]): Promise<CliOptions> {
  const opts: CliOptions = {
    command: 'repl',
    outputFormat: 'text',
    continueLatest: false,
    maxTurns: 512,
    maxTokens: 100_000_000,
    maxDuration: 3600,
    skillsDirs: [],
    skillNames: [],
    files: [],
    acpTools: 'full',
    acpPermission: 'ask',
    ephemeral: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === 'serve' || arg === 'server') {
      opts.command = 'serve'
      continue
    }

    if (arg === 'update' || arg === '--update') {
      opts.command = 'update'
      continue
    }

    if (arg === 'acp') { opts.command = 'acp'; continue }
    if (arg === '--tools' && argv[i + 1]) {
      const tools = argv[++i]
      if (tools !== 'full' && tools !== 'readonly' && tools !== 'none') {
        console.error(`Invalid --tools: ${tools} (expected full, readonly, or none)`)
        process.exit(1)
      }
      opts.acpTools = tools
      continue
    }
    if (arg === '--permission' && argv[i + 1]) {
      const permission = argv[++i]
      if (permission !== 'ask' && permission !== 'allow') {
        console.error(`Invalid --permission: ${permission} (expected ask or allow)`)
        process.exit(1)
      }
      opts.acpPermission = permission
      continue
    }
    if (arg === '--ephemeral') { opts.ephemeral = true; continue }
    if (arg === 'login') { opts.command = 'login'; continue }
    if (arg === 'logout') { opts.command = 'logout'; continue }
    if (arg === 'whoami') { opts.command = 'whoami'; continue }

    if ((arg === '-p' || arg === '--prompt') && argv[i + 1]) {
      opts.command = 'prompt'
      opts.prompt = argv[++i]
      continue
    }
    if ((arg === '-f' || arg === '--file') && argv[i + 1]) { opts.files.push(argv[++i]); continue }
    if (arg === '--model' && argv[i + 1]) { opts.model = argv[++i]; continue }
    if (arg === '--env-file' && argv[i + 1]) { opts.envFile = argv[++i]; continue }
    if (arg === '--port' && argv[i + 1]) { opts.port = parseIntArg(argv[++i], '--port'); continue }
    if ((arg === '-r' || arg === '--resume') && argv[i + 1]) { opts.resume = argv[++i]; continue }
    if (arg === '-c' || arg === '--continue') { opts.continueLatest = true; continue }
    if (arg === '--fork') {
      const next = argv[i + 1]
      opts.fork = next && !next.startsWith('-') ? { sessionId: argv[++i] } : {}
      continue
    }
    if (arg === '--output-format' && argv[i + 1]) {
      const fmt = argv[++i]
      if (fmt !== 'text' && fmt !== 'stream-json') {
        console.error(`Invalid --output-format: ${fmt} (expected text or stream-json)`)
        process.exit(1)
      }
      opts.outputFormat = fmt
      continue
    }
    if (arg === '--max-turns' && argv[i + 1]) { opts.maxTurns = parseIntArg(argv[++i], '--max-turns'); continue }
    if (arg === '--max-tokens' && argv[i + 1]) { opts.maxTokens = parseIntArg(argv[++i], '--max-tokens'); continue }
    if (arg === '--max-duration' && argv[i + 1]) { opts.maxDuration = parseIntArg(argv[++i], '--max-duration'); continue }
    if (arg === '--append-system-prompt' && argv[i + 1]) { opts.appendSystemPrompt = argv[++i]; continue }
    if (arg === '--skills' && argv[i + 1]) { opts.skillsDirs.push(argv[++i]); continue }
    if (arg === '--skill' && argv[i + 1]) { opts.skillNames.push(argv[++i]); continue }

    if (arg === '--version' || arg === '-v') {
      const { version } = await import('./native/index.js')
      console.log(`evot v${version()}`)
      process.exit(0)
    }
    if (arg === '--help' || arg === '-h') {
      await printHelp()
      process.exit(0)
    }
  }

  return opts
}

export { argvForRestart } from './restart-argv.js'

export function parseIntArg(value: string, flag: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n <= 0) {
    console.error(`Invalid ${flag}: ${value} (expected positive integer)`)
    process.exit(1)
  }
  return n
}

export async function printHelp() {
  const { version } = await import('./native/index.js')
  console.log(`evot v${version()} — AI coding assistant`)
  console.log()
  console.log('Usage: evot [command] [options]')
  console.log()
  console.log('Commands:')
  console.log('  (default)              Interactive REPL')
  console.log('  serve                  Start HTTP server')
  console.log('  acp                    Serve the Agent Client Protocol (ACP) on stdio')
  console.log('  update                 Update evot to latest version')
  console.log()
  console.log('Options:')
  console.log('  -p, --prompt <text>    Run one-shot prompt')
  console.log('  -f, --file <path>      Attach file/directory context (repeatable)')
  console.log('  --model <name>         Override the model')
  console.log('  --env-file <path>      Path to evot.env file')
  console.log('  --port <number>        Dashboard port (default: 8082)')
  console.log('  -r, --resume <id>      Resume or create a session by ID')
  console.log('  -c, --continue         Resume the latest session in the current directory')
  console.log('  --fork [id]            Start in a fork of a session (default: latest in cwd)')
  console.log('  --output-format <fmt>  text | stream-json (default: text)')
  console.log('  --max-turns <n>        Max turns (default: 512)')
  console.log('  --max-tokens <n>       Max tokens (default: 100000000)')
  console.log('  --max-duration <secs>  Max duration (default: 3600)')
  console.log('  --append-system-prompt <text>')
  console.log('  --skills <dir>         Skills directory (repeatable)')
  console.log('  --skill <name>         One-shot only: enable a skill by name (repeatable)')
  console.log('  --tools <policy>       acp only: full | readonly | none (default: full)')
  console.log('  --permission <policy>  acp only: ask | allow — ask the client before each tool call (default: ask)')
  console.log('  --ephemeral            acp only: keep sessions in memory, write nothing to disk')
  console.log('  --version, -v          Show version')
  console.log('  --update               Update evot to latest version')
  console.log('  --help, -h             Show this help')
}

export function applyCliOpts(agent: Agent, opts: CliOptions): void {
  agent.setLimits(opts.maxTurns, opts.maxTokens, opts.maxDuration)
  if (opts.appendSystemPrompt) agent.appendSystemPrompt(opts.appendSystemPrompt)
  if (opts.skillsDirs.length > 0) agent.addSkillsDirs(opts.skillsDirs)
  // One-shot runs expose only explicitly selected skills; an empty selection
  // omits the skill index entirely.
  if (opts.command === 'prompt') {
    agent.setSkillNames(opts.skillNames)
  }
}

export async function createAgent(opts: CliOptions): Promise<Agent> {
  try {
    const { Agent: AgentClass } = await import('./native/index.js')
    const agent = await AgentClass.create(opts.model, opts.envFile)
    applyCliOpts(agent, opts)
    return agent
  } catch (err: any) {
    console.error(`Failed to initialize: ${err?.message ?? err}`)
    process.exit(1)
  }
}
