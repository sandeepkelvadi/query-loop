export type ToolContext = {
  abortSignal: AbortSignal
  toolState: Map<string, unknown>
}

export type Tool = {
  name: string
  description: string
  inputSchema: {
    parse: (input: unknown) => Record<string, unknown>
    safeParse: (input: unknown) => { success: true; data: Record<string, unknown> } | { success: false }
  }
  
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean
  isReadOnly?: (input: Record<string, unknown>) => boolean
  
  execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<{ result: unknown }>
  
  renderResult?(result: unknown): string
}

export function toolMatchesName(tool: { name: string; aliases?: string[] }, name: string): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

export function findToolByName<T extends { name: string; aliases?: string[] }>(
  tools: T[],
  name: string
): T | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
}

export type ToolDef = {
  name: string
  description: string
  inputSchema: {
    parse: (input: unknown) => Record<string, unknown>
    safeParse: (input: unknown) => { success: true; data: Record<string, unknown> } | { success: false }
  }
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean
  isReadOnly?: (input: Record<string, unknown>) => boolean
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<{ result: unknown }>
  renderResult?: (result: unknown) => string
}

export function buildTool(def: ToolDef): Tool {
  return {
    ...TOOL_DEFAULTS,
    ...def,
  }
}
