import type { AskState } from '../../widgets/ask.js'
import type { SelectorState } from '../../../ui/selector.js'

/** Application-owned transient surface state. Views consume this union but
 * commands and input routing never need to import the renderer to change it. */
export type OverlayState =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'selector'; state: SelectorState }
  | { kind: 'ask-user'; state: AskState }
