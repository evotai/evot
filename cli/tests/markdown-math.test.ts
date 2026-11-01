import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import chalk from 'chalk'
import { lexRawMarkdownTokens } from '../src/markdown/parse/marked.js'
import { renderLatexMath } from '../src/markdown/math/ansi.js'
import { renderMarkdown } from '../src/render/markdown.js'
import { getTheme, resetThemeCache } from '../src/render/theme/index.js'

function render(source: string): string {
  return stripAnsi(renderMarkdown(source))
}

describe('markdown math tokenization', () => {
  test('recognizes inline dollar and parenthesized delimiters', () => {
    expect(render('Values: $x^2$ and \\(\\alpha_1\\).')).toBe('Values: x² and α₁.')
  })

  test('recognizes same-line and multiline display math', () => {
    expect(render('$$\\frac{a+b}{c}$$')).toBe('  (a+b)/c')
    expect(render('\\[\n\\sqrt{x}\n\\]')).toBe('  √(x)')
  })

  test('emits dedicated tokens without coupling marked to an HTML renderer', () => {
    const block = lexRawMarkdownTokens('$$\nx^2\n$$')
    expect(block[0]?.type).toBe('math_block')

    const paragraph = lexRawMarkdownTokens('before $x_1$ after')
    expect(paragraph[0]?.tokens?.some(token => token.type === 'math_inline')).toBe(true)
  })

  test('renders math inside lists and tables through the shared token renderer', () => {
    expect(render('- Formula: $x^2$')).toContain('Formula: x²')
    const table = render('| Formula |\n| --- |\n| $\\alpha_1$ |')
    expect(table).toContain('α₁')
    expect(table).toContain('┌')
  })

  test('renders double-dollar display math embedded in a sentence', () => {
    expect(render('The result is $$x^2$$ done')).toBe('The result is x² done')
  })

  test('does not parse currency, escaped delimiters, or code as math', () => {
    expect(render('Costs are $100 and $200.')).toBe('Costs are $100 and $200.')
    expect(render('Price range is $5-$10 per unit.')).toBe('Price range is $5-$10 per unit.')
    expect(render('It costs $1,000-$2,000 in total.')).toBe('It costs $1,000-$2,000 in total.')
    expect(render('Then $$ appears twice: $$.')).toBe('Then $$ appears twice: $$.')
    expect(render('Cost $5 and value $x^2$.')).toBe('Cost $5 and value x².')
    expect(render('Shell variables $HOME and $PATH stay literal.')).toBe('Shell variables $HOME and $PATH stay literal.')
    expect(render('Literal \\$x$ text')).toBe('Literal $x$ text')
    expect(render('Use `$x^2$` in docs.')).toContain('$x^2$')
    expect(render('```text\n$$\nx^2\n$$\n```')).toContain('x^2')
  })
})

describe('terminal LaTeX rendering', () => {
  test('renders common symbols, operators, scripts, fractions, roots, and transpose', () => {
    expect(renderLatexMath('\\alpha_1 + \\beta^2 \\leq \\sqrt{x}')).toBe('α₁ + β² ≤ √(x)')
    expect(renderLatexMath('\\frac{a+b}{c}')).toBe('(a+b)/c')
    expect(renderLatexMath('\\sum_{i=1}^{n} i')).toBe('∑ᵢ₌₁ⁿi')
    expect(renderLatexMath('S=\\frac{QK^\\top}{\\sqrt{d_k}}')).toBe('S=QKᵀ/(√(dₖ))')
  })

  test('renders common matrix environments in a terminal-safe linear form', () => {
    const matrix = '\\begin{bmatrix}1&0\\\\1&1\\\\0&1\\end{bmatrix}'
    expect(renderLatexMath(matrix)).toBe('[1, 0; 1, 1; 0, 1]')
  })

  test('renders boxed formulas without forcing the whole expression to raw LaTeX', () => {
    const formula = '\\boxed{\\operatorname{Attention}(Q,K,V)=\\frac{QK^\\top}{\\sqrt{d_k}}}'
    expect(renderLatexMath(formula)).toBe('⟦Attention(Q,K,V)=QKᵀ/(√(dₖ))⟧')
  })

  test('uses normal-weight display math so HTML shots do not exaggerate terminal bold', () => {
    const previousLevel = chalk.level
    const previousTheme = process.env.EVOT_THEME
    chalk.level = 3
    process.env.EVOT_THEME = 'dark'
    resetThemeCache()
    try {
      const expected = chalk.hex('#8abeb7')('x²')
      expect(getTheme().mathBlock.paint('x²')).toBe(expected)
      expect(renderMarkdown('$$x^2$$')).toContain(expected)
      expect(renderMarkdown('$$x^2$$')).not.toContain('\u001b[1m')
    } finally {
      chalk.level = previousLevel
      if (previousTheme === undefined) delete process.env.EVOT_THEME
      else process.env.EVOT_THEME = previousTheme
      resetThemeCache()
    }
  })

  test('falls back to the original LaTeX when a construct is unsupported', () => {
    expect(renderLatexMath('\\unknown{x}')).toBe('\\unknown{x}')
  })
})
