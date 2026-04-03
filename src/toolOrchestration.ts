import type { ToolUseBlock, ToolResultBlock } from './types.js'
import type { Tool, ToolContext } from './tool.js'
import { findToolByName } from './tool.js'

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

async function runToolsSerially(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = []

  for (const toolUse of toolUseBlocks) {
    const result = await executeTool(toolUse, tools, context)
    if (result) results.push(result)
  }

  return results
}

async function runToolsConcurrently(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext
): Promise<ToolResultBlock[]> {
  return Promise.all(
    toolUseBlocks.map(block => executeTool(block, tools, context))
  ).then(results => results.filter((r): r is ToolResultBlock => r !== null))
}

async function executeTool(
  toolUse: ToolUseBlock,
  tools: Tool[],
  context: ToolContext
): Promise<ToolResultBlock | null> {
  const tool = findToolByName(tools, toolUse.name)
  if (!tool) {
    return {
      toolUseId: toolUse.id,
      content: `Tool not found: ${toolUse.name}`,
      isError: true,
    }
  }

  try {
    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      return {
        toolUseId: toolUse.id,
        content: `Invalid input for tool ${toolUse.name}`,
        isError: true,
      }
    }

    const output = await tool.execute(parsed.data, context)
    const content = tool.renderResult
      ? tool.renderResult(output.result)
      : JSON.stringify(output.result)

    return {
      toolUseId: toolUse.id,
      content,
    }
  } catch (error) {
    return {
      toolUseId: toolUse.id,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    }
  }
}

export type ToolExecutor = {
  runToolUseBlocks: (
    toolUseBlocks: ToolUseBlock[],
    tools: Tool[],
    context: ToolContext
  ) => Promise<ToolResultBlock[]>
}

export function createToolExecutor(): ToolExecutor {
  return {
    async runToolUseBlocks(toolUseBlocks, tools, context) {
      const batches = partitionToolCalls(toolUseBlocks, tools)
      const results: ToolResultBlock[] = []

      for (const batch of batches) {
        if (batch.isConcurrencySafe) {
          const batchResults = await runToolsConcurrently(batch.blocks, tools, context)
          results.push(...batchResults)
        } else {
          const batchResults = await runToolsSerially(batch.blocks, tools, context)
          results.push(...batchResults)
        }
      }

      return results
    },
  }
}
