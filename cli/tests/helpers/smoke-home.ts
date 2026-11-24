import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Never pass developer credentials, home paths or provider overrides to a PTY. */
export function smokeEnvironment(
  home: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const state = join(home, '.evotai')
  return {
    PATH: inherited.PATH,
    LANG: inherited.LANG ?? 'en_US.UTF-8',
    TMPDIR: inherited.TMPDIR,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    EVOT_THEME: 'dark',
    EVOT_MOUSE: '0',
    EVOT_AUTO_DOWNLOAD: '0',
    EVOT_HOME: state,
    EVOT_REMOTE_LOCAL_TEST: '1',
    EVOT_STORAGE_FS_ROOT_DIR: state,
  }
}

/** Deterministic local fixtures, not copies of the developer's configuration. */
export function seedSmokeHome(home: string): string {
  const state = join(home, '.evotai')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'evot.env'), [
    'EVOT_LLM_PROVIDER=smoke',
    'EVOT_LLM_SMOKE_API_KEY=smoke-test-key',
    // Closed loopback endpoint: prompts must never reach a real provider.
    'EVOT_LLM_SMOKE_BASE_URL=http://127.0.0.1:1/v1',
    'EVOT_LLM_SMOKE_MODEL=smoke-model,smoke-other-model',
    'EVOT_LLM_SMOKE_PROTOCOL=openai',
    '',
  ].join('\n'))
  const skill = join(state, 'skills', 'smoke-skill')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: smoke-skill\ndescription: Local smoke fixture\n---\nTest fixture.\n')
  return state
}
