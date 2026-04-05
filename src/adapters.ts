import { randomUUID } from 'crypto'
import type { Message, ContentBlock } from './types.js'
import type { Tool } from './tool.js'
import { messageToString } from './message.js'

export type LLMConfig = {
  apiKey: string
  baseUrl?: string
  model?: string
}

export type LLMOptions = {
  maxTurns?: number
  temperature?: number
  systemPrompt?: string
}

abstract class BaseModelAdapter {
  abstract complete(
    messages: Message[],
    tools: Tool[],
    config: LLMOptions
  ): Promise<{ message: Message }>
}

function formatMessagesForAnthropic(messages: Message[]): Array<{ role: string; content: string }> {
  const formatted: Array<{ role: string; content: string }> = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      formatted.push({ role: 'system', content: messageToString(msg) })
    } else if (msg.role === 'user') {
      formatted.push({ role: 'user', content: messageToString(msg) })
    } else if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(block => {
            if (block.type === 'text') return block.text
            if (block.type === 'tool_use') {
              return `[TOOL: ${block.name}]\n${JSON.stringify(block.input)}`
            }
            return ''
          }).join('\n')
      formatted.push({ role: 'assistant', content })
    } else if (msg.role === 'tool') {
      const toolContent = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content)
      formatted.push({ role: 'user', content: `[TOOL RESULT]\n${toolContent}` })
    }
  }

  return formatted
}

export class AnthropicAdapter extends BaseModelAdapter {
  private config: LLMConfig

  constructor(config: LLMConfig) {
    super()
    this.config = {
      model: 'claude-sonnet-4-20250514',
      baseUrl: 'https://api.anthropic.com/v1',
      ...config,
    }
  }

  async complete(
    messages: Message[],
    tools: Tool[],
    config: LLMOptions
  ): Promise<{ message: Message }> {
    const formattedMessages = formatMessagesForAnthropic(messages)
    const systemPrompt = config.systemPrompt || 'You are a helpful AI assistant.'

    const toolDefinitions = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: {},
      },
    }))

    const response = await fetch(`${this.config.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 8192,
        messages: formattedMessages,
        system: systemPrompt,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Anthropic API error: ${response.status} - ${error}`)
    }

    const data = await response.json() as {
      id: string
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
      stop_reason: string
    }

    const contentBlocks: ContentBlock[] = []
    let fullText = ''

    for (const block of data.content) {
      if (block.type === 'text') {
        fullText += block.text || ''
        contentBlocks.push({ type: 'text', text: block.text || '' })
      } else if (block.type === 'tool_use') {
        contentBlocks.push({
          type: 'tool_use',
          id: block.id || `toolu_${randomUUID().slice(0, 8)}`,
          name: block.name || 'unknown',
          input: block.input || {},
        })
      }
    }

    const hasToolCalls = contentBlocks.some(b => b.type === 'tool_use')

    return {
      message: {
        id: data.id,
        role: 'assistant',
        content: hasToolCalls ? contentBlocks : fullText,
        timestamp: Date.now(),
      },
    }
  }
}

export function createAnthropicAdapter(config: LLMConfig): AnthropicAdapter {
  return new AnthropicAdapter(config)
}
