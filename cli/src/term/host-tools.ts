/** Host-owned tool wiring for the interactive REPL.
 *
 *  This module knows one tool: `ask_user`. Feature-specific host tools register
 *  themselves as a `HostToolExtension`, so a feature depends on the dispatcher
 *  and never the other way round.
 */

export interface AskUserOption {
  label: string
  description: string
}

export interface AskUserQuestion {
  header: string
  question: string
  options: AskUserOption[]
}

export interface AskUserParams {
  questions: AskUserQuestion[]
}

export interface AskUserAnswer {
  header: string
  question: string
  answer: string
}

export interface HostToolCall {
  tool_name: string
  tool_call_id: string
  arguments: Record<string, unknown>
}

export interface HostToolResponse {
  tool_call_id: string
  content: Array<{ type: 'text'; text: string }>
  is_error: boolean
}

/** A feature's host tools: what to advertise, what to claim, how to run it. */
export interface HostToolExtension {
  specsJson: string
  handles: (toolName: string) => boolean
  dispatch: (call: HostToolCall) => Promise<HostToolResponse>
}

export const ASK_USER_SPEC = {
  name: 'ask_user',
  label: 'Ask User',
  description: `Ask the user one or more questions when input is required to proceed. Use this tool to clarify requirements, gather preferences, or confirm decisions. Batch related questions into one call.

Return strict JSON matching the schema. Every item in "questions" and "options" is an object and must be enclosed in { }.
Example: {"questions":[{"header":"Scope","question":"Which scope?","options":[{"label":"Minimal (Recommended)","description":"Make the smallest change."},{"label":"Complete","description":"Cover the broader change."}]}]}

Users can always provide a custom answer. If you recommend an option, put it first and append "(Recommended)" to its label.
When there are no meaningful choices and you only need the user to type something (a description, a value, a name), pass "options": [] — the UI then opens a text field directly.`,
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: 'One to four question objects. Each array item must be a complete JSON object enclosed in { }.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            header: { type: 'string', description: 'Short tab label for this question.' },
            question: { type: 'string', description: 'Clear, specific question ending with ?' },
            options: {
              type: 'array',
              minItems: 0,
              maxItems: 4,
              description: "Two to four distinct option objects, or an empty array for a free-text question. Each item must be enclosed in { }. Do not add 'Other'; the UI provides it automatically.",
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', description: 'Concise choice (1-5 words).' },
                  description: { type: 'string', description: 'Brief explanation of the tradeoff.' },
                },
                required: ['label', 'description'],
              },
            },
          },
          required: ['header', 'question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  name_aliases: [['claude', 'AskUser']],
}

export const HOST_TOOL_SPECS_JSON = JSON.stringify([ASK_USER_SPEC])

function isAskUserName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === ASK_USER_SPEC.name || lower === 'askuser'
}

export function errorResponse(call: HostToolCall, text: string): HostToolResponse {
  return {
    tool_call_id: call.tool_call_id,
    content: [{ type: 'text', text }],
    is_error: true,
  }
}

export function textResponse(call: HostToolCall, text: string): HostToolResponse {
  return {
    tool_call_id: call.tool_call_id,
    content: [{ type: 'text', text }],
    is_error: false,
  }
}

export async function dispatchHostToolCall(
  call: HostToolCall,
  collectAnswers: (params: AskUserParams) => Promise<AskUserAnswer[] | null>,
  extension?: HostToolExtension,
): Promise<HostToolResponse> {
  if (extension?.handles(call.tool_name)) return extension.dispatch(call)
  if (!isAskUserName(call.tool_name)) {
    return errorResponse(call, `Unknown host tool: ${call.tool_name}`)
  }
  try {
    const answers = await collectAnswers(call.arguments as unknown as AskUserParams)
    if (!answers) return errorResponse(call, 'User cancelled the question.')
    const lines = ['User answered your questions:']
    for (const answer of answers) lines.push(`- ${answer.question} → ${answer.answer}`)
    return textResponse(call, lines.join('\n'))
  } catch (error) {
    return errorResponse(call, error instanceof Error ? error.message : String(error))
  }
}
