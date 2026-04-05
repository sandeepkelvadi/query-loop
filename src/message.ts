import { randomUUID } from 'crypto'
import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from './types.js'

export function createUserMessage(content: string | ContentBlock[]): Message {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    timestamp: Date.now(),
  }
}

export function createAssistantMessage(content: string | ContentBlock[]): Message {
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
  }
}

export function createToolResultMessage(
  toolUseId: string,
  content: string,
  isError = false
): Message {
  return {
    id: randomUUID(),
    role: 'tool',
    content: JSON.stringify({ toolUseId, content, isError }),
    toolCallId: toolUseId,
    timestamp: Date.now(),
  }
}

export function extractToolUseBlocks(message: Message): ToolUseBlock[] {
  if (typeof message.content === 'string') return []
  
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => 
      block.type === 'tool_use'
    )
    .map(block => ({
      type: 'tool_use' as const,
      id: block.id,
      name: block.name,
      input: block.input,
    }))
}

export function hasToolCalls(message: Message): boolean {
  if (typeof message.content === 'string') return false
  return message.content.some(block => block.type === 'tool_use')
}

export function messageToString(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') return `[TOOL: ${block.name}]`
      if (block.type === 'tool_result') return `[RESULT: ${block.content}]`
      return ''
    })
    .join('')
}
