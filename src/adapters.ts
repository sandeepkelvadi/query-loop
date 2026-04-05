import { randomUUID } from 'crypto'
import type { Message, ContentBlock } from './types.js'
import type { Tool } from './tool.js'
import type { QueryOptions, LLMStreamEvent } from './query.js'
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
    config: QueryOptions
  ): Promise<{ message: Message }>

  async *stream(
    _messages: Message[],
    _tools: Tool[],
    _config: QueryOptions
  ): AsyncGenerator<LLMStreamEvent, Message, unknown> {
    const { message } = await this.complete(_messages, _tools, _config)
    const text = typeof message.content === 'string'
      ? message.content
      : messageToString(message)
    yield { type: 'text_complete', text }
    return message
  }
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

interface AnthropicStreamEvent {
  type: string
  index?: number
  content_block_start?: { type: string; index: number }
  content_block_delta?: { type: string; index: number; delta: { type: string; text?: string } }
  content_block_stop?: { index: number }
  message_start?: { message: { id: string; role: string; content: unknown[]; stop_reason: string } }
  message_delta?: { delta: { stop_reason: string }; usage: { output_tokens: number } }
  message_stop?: object
  error?: { type: string; error: { type: string; message: string } }
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

  async *stream(
    messages: Message[],
    tools: Tool[],
    config: QueryOptions
  ): AsyncGenerator<LLMStreamEvent, Message, unknown> {
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
        stream: true,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Anthropic API error: ${response.status} - ${error}`)
    }

    if (!response.body) {
      throw new Error('No response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    let fullText = ''
    let currentToolCall: { id: string; name: string; input: Record<string, unknown> } | null = null
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break

        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          let event: AnthropicStreamEvent
          try {
            event = JSON.parse(data)
          } catch {
            continue
          }

          if (event.error) {
            throw new Error(`API error: ${event.error.error.message}`)
          }

          if (event.type === 'content_block_start') {
            const block = event.content_block_start!
            if (block.type === 'tool_use') {
              currentToolCall = {
                id: `toolu_${randomUUID().slice(0, 8)}`,
                name: '',
                input: {},
              }
            }
          }

          if (event.type === 'content_block_delta') {
            const delta = event.content_block_delta!
            if (delta.delta.type === 'text_delta' && delta.delta.text) {
              fullText += delta.delta.text
              yield { type: 'text_delta', delta: delta.delta.text }
            } else if (currentToolCall) {
              if (delta.delta.type === 'input_json_delta' && delta.delta.text) {
                try {
                  const partialInput = JSON.parse(delta.delta.text)
                  currentToolCall.input = { ...currentToolCall.input, ...partialInput }
                } catch {
                  currentToolCall.input._partial = (currentToolCall.input._partial as string || '') + delta.delta.text
                }
                yield { type: 'tool_use_delta', toolCallId: currentToolCall.id, delta: delta.delta.text }
              }
            }
          }

          if (event.type === 'content_block_stop') {
            if (currentToolCall) {
              toolCalls.push(currentToolCall)
              yield {
                type: 'tool_use_complete',
                toolCall: {
                  type: 'tool_use' as const,
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  input: currentToolCall.input,
                },
              }
              currentToolCall = null
            }
          }

          if (event.type === 'message_start') {
          }

          if (event.type === 'message_delta') {
          }

          if (event.type === 'message_stop') {
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const contentBlocks: ContentBlock[] = []

    if (fullText) {
      contentBlocks.push({ type: 'text', text: fullText })
    }

    for (const tc of toolCalls) {
      if (tc.name) {
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })
      }
    }

    const hasToolCalls = toolCalls.some(t => t.name)

    const message: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: hasToolCalls ? contentBlocks : fullText,
      timestamp: Date.now(),
    }

    if (!hasToolCalls) {
      yield { type: 'text_complete', text: fullText }
    }

    return message
  }

  async complete(
    messages: Message[],
    tools: Tool[],
    config: QueryOptions
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
