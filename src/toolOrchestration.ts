import type { ToolUseBlock, ToolResultBlock } from './types.js'
import type { Tool, ToolContext } from './tool.js'
import { findToolByName } from './tool.js'

export type ToolProgressEvent = {
  type: 'progress'
  toolUseId: string
  content: string
}

export type ToolResultEvent =
  | ToolProgressEvent
  | { type: 'complete'; toolUseId: string; result: ToolResultBlock }

type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

function partitionToolCalls(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[]
): Batch[] {
  return toolUseBlocks.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (tool?.isConcurrencySafe?.(parsedInput.data) ?? false)
      : false
    
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

async function* runToolWithProgress(
  toolUse: ToolUseBlock,
  tool: Tool,
  context: ToolContext
): AsyncGenerator<ToolResultEvent, ToolResultBlock> {
  const parsed = tool.inputSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    const result: ToolResultBlock = {
      toolUseId: toolUse.id,
      content: `Invalid input for tool ${toolUse.name}`,
      isError: true,
    }
    yield { type: 'complete', toolUseId: toolUse.id, result }
    return result
  }

  const progressCallback = (content: string) => {
    return { type: 'progress' as const, toolUseId: toolUse.id, content }
  }

  const toolContextWithProgress: ToolContext = {
    ...context,
    onProgress: progressCallback,
  }

  try {
    const output = await tool.execute(parsed.data, toolContextWithProgress)
    const content = tool.renderResult
      ? tool.renderResult(output.result)
      : JSON.stringify(output.result)

    const result: ToolResultBlock = {
      toolUseId: toolUse.id,
      content,
    }
    yield { type: 'complete', toolUseId: toolUse.id, result }
    return result
  } catch (error) {
    const result: ToolResultBlock = {
      toolUseId: toolUse.id,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    }
    yield { type: 'complete', toolUseId: toolUse.id, result }
    return result
  }
}

async function* runToolsSerially(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext
): AsyncGenerator<ToolResultEvent, ToolResultBlock[]> {
  const results: ToolResultBlock[] = []

  for (const toolUse of toolUseBlocks) {
    const tool = findToolByName(tools, toolUse.name)
    if (!tool) {
      const result: ToolResultBlock = {
        toolUseId: toolUse.id,
        content: `Tool not found: ${toolUse.name}`,
        isError: true,
      }
      yield { type: 'complete', toolUseId: toolUse.id, result }
      results.push(result)
      continue
    }

    for await (const event of runToolWithProgress(toolUse, tool, context)) {
      yield event
      if (event.type === 'complete') {
        results.push(event.result)
      }
    }
  }

  return results
}

async function* runToolsConcurrently(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext
): AsyncGenerator<ToolResultEvent, ToolResultBlock[]> {
  const promises = toolUseBlocks.map(async (toolUse): Promise<{ events: ToolResultEvent[]; result: ToolResultBlock }> => {
    const tool = findToolByName(tools, toolUse.name)
    if (!tool) {
      const result: ToolResultBlock = {
        toolUseId: toolUse.id,
        content: `Tool not found: ${toolUse.name}`,
        isError: true,
      }
      return { events: [{ type: 'complete', toolUseId: toolUse.id, result }], result }
    }

    const events: ToolResultEvent[] = []
    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      const result: ToolResultBlock = {
        toolUseId: toolUse.id,
        content: `Invalid input for tool ${toolUse.name}`,
        isError: true,
      }
      events.push({ type: 'complete', toolUseId: toolUse.id, result })
      return { events, result }
    }

    try {
      const output = await tool.execute(parsed.data, context)
      const content = tool.renderResult
        ? tool.renderResult(output.result)
        : JSON.stringify(output.result)

      const result: ToolResultBlock = {
        toolUseId: toolUse.id,
        content,
      }
      events.push({ type: 'complete', toolUseId: toolUse.id, result })
      return { events, result }
    } catch (error) {
      const result: ToolResultBlock = {
        toolUseId: toolUse.id,
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
      events.push({ type: 'complete', toolUseId: toolUse.id, result })
      return { events, result }
    }
  })

  const allResults: ToolResultBlock[] = []
  
  const settled = await Promise.all(promises)
  for (const { events, result } of settled) {
    for (const event of events) {
      yield event
    }
    allResults.push(result)
  }

  return allResults
}

export type ToolExecutor = {
  runToolUseBlocks: (
    toolUseBlocks: ToolUseBlock[],
    tools: Tool[],
    context: ToolContext
  ) => AsyncGenerator<ToolResultEvent, ToolResultBlock[]>
}

export function createToolExecutor(): ToolExecutor {
  return {
    async *runToolUseBlocks(toolUseBlocks, tools, context) {
      const batches = partitionToolCalls(toolUseBlocks, tools)
      const results: ToolResultBlock[] = []

      for (const batch of batches) {
        if (batch.isConcurrencySafe) {
          const batchResults = runToolsConcurrently(batch.blocks, tools, context)
          for await (const event of batchResults) {
            yield event
            if (event.type === 'complete') {
              results.push(event.result)
            }
          }
        } else {
          const batchResults = runToolsSerially(batch.blocks, tools, context)
          for await (const event of batchResults) {
            yield event
            if (event.type === 'complete') {
              results.push(event.result)
            }
          }
        }
      }

      return results
    },
  }
}
