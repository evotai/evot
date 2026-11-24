// CSS for the phone's TUI Markdown (`markdown/render/html.ts`), derived from the
// same styles the TUI paints with: each theme Style and each cli-highlight token
// style is painted once and its SGR codes become declarations. Basic ANSI colours
// resolve through the terminal palette, as they do in the user's terminal.
import chalk from 'chalk'
import { DEFAULT_THEME } from 'cli-highlight/dist/theme.js'
import type { Theme } from '../../ui/theme/types.js'

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
/** Warp Fancy Dracula's terminal colours (warpdotdev/themes, warp_bundled/fancy_dracula.yaml). */
const DARK_ANSI = {
  normal: ['#000000', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#bbbbbb'],
  bright: ['#555555', '#ff5555', '#50fa7b', '#f1fa8c', '#caa9fa', '#ff79c6', '#8be9fd', '#ffffff'],
}
/** A light terminal palette with readable contrast on white. */
const LIGHT_ANSI = {
  normal: ['#000000', '#cd3131', '#107c10', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555'],
  bright: ['#666666', '#cd3131', '#14a014', '#b5ba00', '#0451a5', '#bc05bc', '#0598bc', '#a5a5a5'],
}

function ansiVars(p: typeof DARK_ANSI) {
  return NAMES.map((n, i) => `--ansi-${n}:${p.normal[i]}; --ansi-bright-${n}:${p.bright[i]};`).join(' ')
}

/** Declarations for whatever one painted sample turns on. */
function sgrCss(painted: string): string {
  const out: string[] = []
  for (const [, params] of painted.matchAll(/\x1b\[([\d;]*)m/g)) {
    const codes = params!.split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!
      if (c === 1) out.push('font-weight:700')
      else if (c === 2) out.push('opacity:.7')
      else if (c === 3) out.push('font-style:italic')
      else if (c === 4) out.push('text-decoration:underline')
      else if (c >= 30 && c <= 37) out.push(`color:var(--ansi-${NAMES[c - 30]})`)
      else if (c >= 90 && c <= 97) out.push(`color:var(--ansi-bright-${NAMES[c - 90]})`)
      else if (c === 38 && codes[i + 1] === 2) {
        const [r, g, b] = codes.slice(i + 2, i + 5)
        out.push('color:#' + [r, g, b].map(v => (v ?? 0).toString(16).padStart(2, '0')).join(''))
        i += 4
      }
    }
  }
  return [...new Set(out)].join(';')
}

// cli-highlight paints with its own chalk 4, whose colour level follows this process's
// terminal; its styler still records the codes it would emit.
function highlightCss(paint: (s: string) => string) {
  const open = (paint as unknown as { _styler?: { openAll?: string } })._styler?.openAll
  return sgrCss(typeof open === 'string' ? open : paint('x'))
}

function rules(scope: string, theme: Theme) {
  const css = (s: { paint(t: string): string }) => sgrCss(s.paint('x'))
  const rule = (selector: string, decl: string) => decl ? `${selector.split(',').map(s => `${scope} ${s.trim()}`).join(',')} { ${decl} }` : ''
  const color = (decl: string) => decl.match(/color:[^;]+/)?.[0].slice(6) ?? 'currentColor'
  return [
    rule('.md-strong', css(theme.bold)), rule('.md-em', css(theme.italic)), rule('.md-code', css(theme.codeInline)),
    ...[1, 2, 3, 4, 5, 6].map(n => rule(`.md-h${n}`, css(theme[`h${n}` as 'h1']))),
    rule('.md-list:is(ul) > li::marker', css(theme.bullet)), rule('.md-list:is(ol) > li::marker', css(theme.listNumber)),
    rule('.md-quote', css(theme.blockquoteText) + `;border-inline-start-color:${color(css(theme.blockquoteBorder))}`),
    rule('.md-table :is(th,td)', `border-color:${color(css(theme.tableBorder))}`), rule('.md-table th', css(theme.tableHeader)),
    rule('.md-hr', `border-color:${color(css(theme.hr))}`), rule('.md-diagram', `color:${color(css(theme.tableBorder))}`),
    rule('.code-block .code-head', css(theme.codeBlockBorder)), rule('.md-math', css(theme.mathInline)),
    // The TUI's links are the terminal's blue (createHyperlink paints chalk.blue).
    rule('.md-link', sgrCss(chalk.blue('x'))),
    ...Object.entries(DEFAULT_THEME).map(([key, paint]) => typeof paint === 'function' ? rule(`.hljs-${key}`, highlightCss(paint)) : ''),
  ].filter(Boolean).join('\n')
}

export function markdownCss(dark: Theme, light: Theme) {
  const level = chalk.level
  chalk.level = 3 // read the styles' full colour, whatever this terminal reports
  try {
    return [
      `html.remote-shell:not([data-theme="light"]) { ${ansiVars(DARK_ANSI)} }`,
      `html.remote-shell[data-theme="light"] { ${ansiVars(LIGHT_ANSI)} }`,
      rules('html.remote-shell:not([data-theme="light"])', dark),
      rules('html.remote-shell[data-theme="light"]', light),
    ].join('\n')
  } finally { chalk.level = level }
}
