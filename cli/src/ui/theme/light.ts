/**
 * Light palette. Same structure as `dark.ts`; every hue is deepened so it
 * holds contrast on white (the dark theme's gold and lime wash out there).
 * See dark.ts for why chalk.hex() is called lazily at paint time.
 */

import chalk from 'chalk'
import { plain, style, type Theme } from './types.js'

const brandHex = '#5769f7'
const accentHex = '#b8860b'
// A slightly deeper teal reads better on a light background than #8abeb7.
const tealHex = '#5a8080'

export function lightTheme(): Theme {
  return {
    brand: style(s => chalk.hex(brandHex)(s)),
    brandBold: style(s => chalk.hex(brandHex).bold(s)),
    brandHex,
    accent: style(s => chalk.hex(accentHex)(s)),
    accentBold: style(s => chalk.hex(accentHex).bold(s)),
    accentHex,

    // Light counterpart of the dark selection fill: a pale periwinkle wash that
    // keeps the brand-hued label readable on a white background.
    mutedHex: '#777777',
    // Light mirror of the dark theme's gauge tone: on a light page an empty
    // cell has to sit *above* muted to stay visible, not below it.
    subtleHex: '#b8b8b8',
    effortRampHex: ['#3f9142', '#8a9a1c', '#b07f12', '#d9741f', '#cb4b4b', '#8d4bb8'],
    selectionBgHex: '#dfe3fd',
    selectionMutedHex: '#5b6070',

    // Darker, more saturated green: the dark theme's lime disappears on white.
    // The block flips to white text against it.
    cursorHex: '#3f9142',
    cursorFgHex: '#ffffff',
    // Devin's light `--status-error`: deep enough to hold contrast on white.
    errorHex: '#cb2431',

    // Pale periwinkle panel, a few points off white; diff rows a shade deeper.
    panelBg: '#eceef8',
    panelFg: '#252a3a',
    panelMutedFg: '#5b6070',
    // One neutral tool fill, a pale wash a step off the panel.
    toolCardBg: '#eceef5',
    diffAddedBg: '#d3ecdc',
    diffRemovedBg: '#f6d8dc',
    // See dark.ts: changed tokens get a stronger fill instead of inverse video.
    // Contrast against row tint / word fill: add 6.49 / 5.16, del 6.88 / 5.08.
    diffAddedFg: '#0f5c2c',
    diffRemovedFg: '#8f1424',
    diffAddedWordBg: '#a9d9bd',
    diffRemovedWordBg: '#f0b0bc',
    diffGutterFg: '#7a8092',
    diffContextFg: '#5b6070',

    text: plain,
    // See darkTheme: emphasis needs a hue, darker gold to hold contrast on white.
    bold: style(s => chalk.hex(accentHex).bold(s)),
    italic: style(s => chalk.italic(s)),
    boldItalic: style(s => chalk.hex(accentHex).bold.italic(s)),
    strikethrough: style(s => chalk.dim.strikethrough(s)),
    underline: style(s => chalk.underline(s)),
    // See darkTheme: link stays neutral and relies on OSC 8 for clickability.
    link: plain,
    // Inline code colour mirrors claudecode's `permission` hex exactly:
    // rgb(87,105,247) = #5769f7 (medium blue).
    codeInline: style(s => chalk.hex('#5769f7')(s)),
    mathInline: style(s => chalk.hex('#327878')(s)),
    mathBlock: style(s => chalk.hex('#327878')(s)),

    // Darker gold than the dark-theme accent so headings stay legible on a
    // light background. Same warm family as evot's brand accent.
    h1: style(s => chalk.hex(accentHex).bold.italic.underline(s)),
    h2: style(s => chalk.hex(accentHex).bold(s)),
    h3: style(s => chalk.hex(accentHex).bold(s)),
    h4: style(s => chalk.hex(accentHex).bold(s)),
    h5: style(s => chalk.hex(accentHex).bold(s)),
    h6: style(s => chalk.hex(accentHex).bold(s)),

    bullet: style(s => chalk.hex(tealHex)(s)),
    listNumber: style(s => chalk.hex(tealHex)(s)),

    blockquoteBorder: style(s => chalk.hex('#6a6a6a')(s)),
    blockquoteText: style(s => chalk.italic(s)),

    tableBorder: style(s => chalk.hex('#8a8a8a')(s)),
    tableHeader: style(s => chalk.bold(s)),

    hr: style(s => chalk.hex('#6a6a6a')(s)),
    codeBlockBorder: style(s => chalk.hex('#8a8a8a')(s)),
    thinkHeader: style(s => chalk.hex(accentHex)(s)),
    thinkText: style(s => chalk.hex('#6c6c6c')(s)),
  }
}
