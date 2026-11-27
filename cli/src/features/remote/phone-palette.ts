import { darkTheme } from '../../ui/theme/dark.js'
import { lightTheme } from '../../ui/theme/light.js'
import type { Theme } from '../../ui/theme/types.js'

// Shared by both Remote documents. Review never guesses a theme from the OS.
function palette(t: Theme) {
  return `--accent:${t.brandHex}; --amber:${t.accentHex}; --green:${t.cursorHex}; --red:${t.errorHex};
    --ink:${t.panelFg}; --muted:${t.panelMutedFg}; --faint:${t.selectionMutedHex};
    --raised-bg:${t.panelBg}; --fill:${t.toolCardBg}; --accent-soft:${t.selectionBgHex};
    --diff-add-bg:${t.diffAddedBg}; --diff-remove-bg:${t.diffRemovedBg}; --diff-add-fg:${t.diffAddedFg}; --diff-remove-fg:${t.diffRemovedFg};
    --diff-add-word:${t.diffAddedWordBg}; --diff-remove-word:${t.diffRemovedWordBg}; --diff-gutter:${t.diffGutterFg};
    --diff-context:${t.diffContextFg}; --diff-header-fg:${t.diffHeaderFg}; --diff-header-bg:${t.diffHeaderBg};`
}
const top = '#252630', bottom = '#3d3f4f'
export const phonePalette = `html.remote-shell:not([data-theme="light"]) { ${palette(darkTheme())}
  color-scheme:dark; --page:color-mix(in srgb,${top},${bottom}); --page-gradient:linear-gradient(180deg,${top},${bottom});
  --side-bg:${top}; --bg:var(--raised-bg); --btn-ink:#1a1d24; --line:color-mix(in srgb,var(--ink) 12%,transparent); }
  html.remote-shell[data-theme="light"] { ${palette(lightTheme())} color-scheme:light; --page-gradient:none;
  --page:#fcfcfe; --bg:#fff; --side-bg:#f6f7fc; --btn-ink:#fff; --line:color-mix(in srgb,var(--ink) 14%,transparent); }`
