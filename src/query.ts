import { randomUUID } from 'crypto'
import type { Message, ToolUseBlock, ToolResultBlock } from './types.js'
import { createToolResultMessage, extractToolUseBlocks, hasToolCalls, messageToString } from './message.js'
import { createToolExecutor } from './toolOrchestration.js'
import type { Tool, ToolContext } from './tool.js'

export type QueryOptions = {
  maxTurns?: number
  temperature?: number
  systemPrompt?: string
}

type QueryState = {
  messages: Message[]
  turnCount: number
  abortController: AbortController
}

export type LLMStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'text_complete'; text: string }
  | { type: 'tool_use_start'; toolCall: ToolUseBlock }
  | { type: 'tool_use_delta'; toolCallId: string; delta: string }
  | { type: 'tool_use_complete'; toolCall: ToolUseBlock }
  | { type: 'turn_end'; turnCount: number }
  | { type: 'complete'; finalContent: string }

export type MessageStreamEvent =
  | { type: 'assistant'; content: string }
  | { type: 'assistant_delta'; delta: string }
  | { type: 'tool_use'; toolCall: ToolUseBlock }
  | { type: 'tool_progress'; toolUseId: string; content: string }
  | { type: 'tool_result'; result: ToolResultBlock }
  | { type: 'turn_end'; turnCount: number }
  | { type: 'complete'; finalContent: string }

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

class MockModelAdapter extends BaseModelAdapter {
  async complete(
    messages: Message[],
    _tools: Tool[],
    _config: QueryOptions
  ): Promise<{ message: Message }> {
    const lastMessage = messages[messages.length - 1]
    const userContent = typeof lastMessage?.content === 'string'
      ? lastMessage.content
      : 'No content'

    const content = `Echo: ${userContent}`

    return {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
    }
  }
}

export class QueryLoop {
  private tools: Tool[]
  private config: QueryOptions
  private executor = createToolExecutor()
  private modelAdapter: BaseModelAdapter
  private state: QueryState

  constructor(
    tools: Tool[] = [],
    config: QueryOptions = {},
    modelAdapter?: BaseModelAdapter
  ) {
    this.tools = tools
    this.config = {
      maxTurns: 10,
      temperature: 0.7,
      ...config,
    }
    this.modelAdapter = modelAdapter ?? new MockModelAdapter()
    this.state = {
      messages: [],
      turnCount: 0,
      abortController: new AbortController(),
    }
  }

  async *query(
    initialMessages: Message[] = [],
    initialUserInput: string
  ): AsyncGenerator<MessageStreamEvent, string, unknown> {
    this.state = {
      messages: [...initialMessages],
      turnCount: 0,
      abortController: new AbortController(),
    }

    if (initialUserInput) {
      this.state.messages.push({
        id: randomUUID(),
        role: 'user',
        content: initialUserInput,
        timestamp: Date.now(),
      })
    }

    while (this.state.turnCount < (this.config.maxTurns ?? 10)) {
      if (this.state.abortController.signal.aborted) {
        break
      }

      this.state.turnCount++

      let fullText = ''
      let toolCalls: ToolUseBlock[] = []
      let streamingToolInput = ''
      let currentToolCall: ToolUseBlock | null = null

      for await (const event of this.modelAdapter.stream(
        this.state.messages,
        this.tools,
        this.config
      )) {
        if (event.type === 'text_delta') {
          fullText += event.delta
          yield { type: 'assistant_delta', delta: event.delta }
        }

        if (event.type === 'text_complete') {
          fullText = event.text
          yield { type: 'assistant', content: event.text }
        }

        if (event.type === 'tool_use_start') {
          currentToolCall = event.toolCall
          streamingToolInput = ''
          yield { type: 'tool_use', toolCall: event.toolCall }
        }

        if (event.type === 'tool_use_delta' && currentToolCall) {
          streamingToolInput += event.delta
          currentToolCall.input = this.parsePartialJson(streamingToolInput)
        }

        if (event.type === 'tool_use_complete' && currentToolCall) {
          currentToolCall.input = this.parsePartialJson(streamingToolInput)
          toolCalls.push(currentToolCall)
          currentToolCall = null
          streamingToolInput = ''
        }
      }

      if (toolCalls.length === 0 && fullText) {
        const message: Message = {
          id: randomUUID(),
          role: 'assistant',
          content: fullText,
          timestamp: Date.now(),
        }
        this.state.messages.push(message)
        yield { type: 'complete', finalContent: fullText }
        return fullText
      }

      if (toolCalls.length === 0) {
        const lastMsg = this.state.messages[this.state.messages.length - 1]
        const content = typeof lastMsg?.content === 'string'
          ? lastMsg.content
          : messageToString(lastMsg)
        yield { type: 'complete', finalContent: content }
        return content
      }

      const assistantMessage: Message = {
        id: randomUUID(),
        role: 'assistant',
        content: toolCalls,
        timestamp: Date.now(),
      }
      this.state.messages.push(assistantMessage)

      const toolContext: ToolContext = {
        abortSignal: this.state.abortController.signal,
        toolState: new Map(),
      }

      const toolResultIterator = this.executor.runToolUseBlocks(
        toolCalls,
        this.tools,
        toolContext
      )

      let toolResults: ToolResultBlock[] = []
      for await (const event of toolResultIterator) {
        if (event.type === 'progress') {
          yield { type: 'tool_progress', toolUseId: event.toolUseId, content: event.content }
        } else if (event.type === 'complete') {
          toolResults.push(event.result)
          yield { type: 'tool_result', result: event.result }
          this.state.messages.push(createToolResultMessage(
            event.result.toolUseId,
            event.result.content,
            event.result.isError
          ))
        }
      }

      yield { type: 'turn_end', turnCount: this.state.turnCount }
    }

    const lastMessage = this.state.messages[this.state.messages.length - 1]
    const finalContent = typeof lastMessage?.content === 'string'
      ? lastMessage.content
      : ''

    yield { type: 'complete', finalContent }
    return finalContent
  }

  private parsePartialJson(input: string): Record<string, unknown> {
    try {
      return JSON.parse(input)
    } catch {
      return { _partial: input }
    }
  }

  abort(): void {
    this.state.abortController.abort()
  }

  getMessages(): readonly Message[] {
    return this.state.messages
  }

  addTool(tool: Tool): void {
    this.tools.push(tool)
  }
}

export function createQueryLoop(
  tools?: Tool[],
  config?: QueryOptions,
  modelAdapter?: BaseModelAdapter
): QueryLoop {
  return new QueryLoop(tools, config, modelAdapter)
}
