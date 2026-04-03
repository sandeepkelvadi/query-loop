export type Message = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentBlock[]
  name?: string
  toolCallId?: string
  toolName?: string
  timestamp: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export type ToolUseBlock = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultBlock = {
  toolUseId: string
  content: string
  isError?: boolean
}

export type StreamEvent =
  | { type: 'content_block_start'; block: ContentBlock }
  | { type: 'content_block_delta'; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; delta: string } }
  | { type: 'content_block_stop' }
  | { type: 'message_start'; message: Message }
  | { type: 'message_delta'; delta: { stop_reason: string | null } }
  | { type: 'message_stop' }

export type QueryResult =
  | { type: 'result'; content: string; reason: 'completed' | 'max_turns' | 'error' }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'tool_use'; toolCall: ToolUseBlock }
  | { type: 'tool_result'; result: ToolResultBlock }
