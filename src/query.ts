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

export type MessageStreamEvent =
  | { type: 'assistant'; content: string }
  | { type: 'tool_use'; toolCall: ToolUseBlock }
  | { type: 'tool_result'; result: ToolResultBlock }
  | { type: 'turn_end'; turnCount: number }
  | { type: 'complete'; finalContent: string }

abstract class BaseModelAdapter {
  abstract complete(
    messages: Message[],
    tools: Tool[],
    config: QueryOptions
  ): Promise<{ message: Message; rawEvents?: unknown[] }>
}

class MockModelAdapter extends BaseModelAdapter {
  async complete(
    messages: Message[],
    _tools: Tool[],
    _config: QueryOptions
  ): Promise<{ message: Message; rawEvents?: unknown[] }> {
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

      const { message } = await this.modelAdapter.complete(
        this.state.messages,
        this.tools,
        this.config
      )

      this.state.messages.push(message)

      const content = typeof message.content === 'string'
        ? message.content
        : messageToString(message)

      yield { type: 'assistant', content }

      const toolCalls = extractToolUseBlocks(message)

      if (toolCalls.length === 0) {
        yield { type: 'complete', finalContent: content }
        return content
      }

      for (const toolCall of toolCalls) {
        yield { type: 'tool_use', toolCall }
      }

      const toolContext: ToolContext = {
        abortSignal: this.state.abortController.signal,
        toolState: new Map(),
      }

      const toolResults = await this.executor.runToolUseBlocks(
        toolCalls,
        this.tools,
        toolContext
      )

      for (const result of toolResults) {
        yield { type: 'tool_result', result }
        this.state.messages.push(createToolResultMessage(
          result.toolUseId,
          result.content,
          result.isError
        ))
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
