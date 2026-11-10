/**
 * Dark palette. Colors are kept narrow (two brand hues + three shades of
 * gray + one teal) to stay coherent across components.
 *
 * Always call chalk.hex() at paint time. Binding `const accent = chalk.hex(...)`
 * at construction freezes chalk's color-level approximation: if the theme is
 * first built while chalk.level is 0/1 (no TTY, CI), headings/fences stay stuck
 * on 16-color SGR even after log-shot forces level 3. Lazy hex keeps truecolor
 * stable across environments.
 */

import chalk from 'chalk'
import { plain, style, type Theme } from './types.js'

// EVOT's primary periwinkle, sampled from the canonical terminal wordmark.
const brandHex = '#b5bcf9'
const accentHex = '#f0c674'
// Secondary accent — the teal evot uses for banner links / 'evot update'.
const tealHex = '#8abeb7'

export function darkTheme(): Theme {
  return {
    brand: style(s => chalk.hex(brandHex)(s)),
    brandBold: style(s => chalk.hex(brandHex).bold(s)),
    brandHex,
    accent: style(s => chalk.hex(accentHex)(s)),
    accentBold: style(s => chalk.hex(accentHex).bold(s)),
    accentHex,

    // Desaturated periwinkle: reads as "same family as the frame" while staying
    // dark enough that brand-hued text on top keeps its contrast.
    mutedHex: '#777777',
    // Devin's `--border-default` (#444444) for a gauge's unfilled cells: dark
    // enough to read as an empty slot, light enough to still show the ladder.
    subtleHex: '#4a4a4a',
    // Green → amber → coral → violet, as in Devin's pricing bar; avoids accentHex.
    effortRampHex: ['#8ccf7e', '#c9d36a', '#e9c26e', '#f0a06a', '#e58a8a', '#c58ad7'],
    selectionBgHex: '#2c2f4a',
    selectionMutedHex: '#9aa0b4',

    // Lime, against a periwinkle frame: the caret has to win attention over
    // everything around it, so it sits outside the brand palette. When the
    // cursor sits on a character, that cell flips to a lime block with near
    // black text — bright enough to read, close to a real terminal caret.
    cursorHex: '#9ae65c',
    cursorFgHex: '#1a1d24',
    // Devin's dark `--status-error`: warm and readable on the slate fills
    // without the neon edge of most terminals' ANSI red.
    errorHex: '#f44747',

    // The panel is a periwinkle-tinted slate: opencode keeps its panel one
    // step above the page, but evot cannot see the terminal's page colour, so
    // this sits high enough to read on black, #1e1e1e, and One Dark alike
    // while staying under `selectionBgHex`. Diff rows tint a touch stronger so
    // +/- read through the panel.
    panelBg: '#2a2e44',
    panelFg: '#e5e7ef',
    panelMutedFg: '#a6adbf',
    // One neutral tool fill: a cooled, darkened step of the panel. Lifecycle
    // state lives in the status glyph, not the slab, so a transcript full of
    // cards reads as one calm surface. Diff rows tint a touch stronger so +/-
    // read through the card fill.
    toolCardBg: '#262838',
    diffAddedBg: '#213a2f',
    diffRemovedBg: '#43262e',
    // Zed's second layer: changed tokens get their own, stronger fill instead
    // of inverse video (SGR 7), which on most terminals flips to the terminal's
    // own palette and tears a bright hole through the card. Contrast against
    // both the row tint and this fill: add 7.83 / 4.03, del 7.83 / 5.45.
    diffAddedFg: '#8fe0a8',
    diffRemovedFg: '#f8b3bd',
    diffAddedWordBg: '#2f6b49',
    diffRemovedWordBg: '#7a2b3a',
    diffGutterFg: '#6f7488',
    diffContextFg: '#8b90a4',

    text: plain,
    // Hue, not just weight: terminals whose font lacks a bold face drop SGR 1,
    // which made `**bold**` read as body text.
    bold: style(s => chalk.hex(accentHex).bold(s)),
    italic: style(s => chalk.italic(s)),
    boldItalic: style(s => chalk.hex(accentHex).bold.italic(s)),
    strikethrough: style(s => chalk.dim.strikethrough(s)),
    underline: style(s => chalk.underline(s)),
    // link style follows claudecode: rely on OSC 8 for clickability and keep
    // the URL in normal colour. Fallback is a bare URL without underline/hue.
    link: plain,
    // Inline code colour mirrors claudecode's `permission` hex exactly:
    // rgb(177,185,249) = #b1b9f9 (light blue-purple). Keeps `foo()`
    // references in the same semantic family as links without dominating
    // long prose on dark terminals.
    codeInline: style(s => chalk.hex('#b1b9f9')(s)),
    mathInline: style(s => chalk.hex(tealHex)(s)),
    mathBlock: style(s => chalk.hex(tealHex)(s)),

    // Headings carry evot's gold accent (matches the banner + pi's mdHeading).
    // h1 keeps the extra italic·underline emphasis; h2+ are accent-bold so
    // every level reads as a distinct section marker.
    h1: style(s => chalk.hex(accentHex).bold.italic.underline(s)),
    h2: style(s => chalk.hex(accentHex).bold(s)),
    h3: style(s => chalk.hex(accentHex).bold(s)),
    h4: style(s => chalk.hex(accentHex).bold(s)),
    h5: style(s => chalk.hex(accentHex).bold(s)),
    h6: style(s => chalk.hex(accentHex).bold(s)),

    // pi tints list markers with its accent; we mirror that so bullets and
    // ordinals read as structure without competing with the gold headings.
    bullet: style(s => chalk.hex(tealHex)(s)),
    listNumber: style(s => chalk.hex(tealHex)(s)),

    blockquoteBorder: style(s => chalk.hex('#808080')(s)),
    // Italic but not dim — dimGray on dark backgrounds is nearly invisible
    // for long CJK quotes.
    blockquoteText: style(s => chalk.italic(s)),

    tableBorder: style(s => chalk.hex('#8a8a8a')(s)),
    tableHeader: style(s => chalk.bold(s)),

    hr: style(s => chalk.hex('#808080')(s)),
    codeBlockBorder: style(s => chalk.hex('#6a6a6a')(s)),
    thinkHeader: style(s => chalk.hex(accentHex)(s)),
    thinkText: style(s => chalk.hex('#8a8a8a')(s)),
  }
}
