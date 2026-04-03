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

// ============================================================================
// Built-in Tools
// ============================================================================

/**
 * ReadTool - Read contents of a file
 */
export const ReadTool = buildTool({
  name: 'Read',
  description: 'Read the contents of a file',
  inputSchema: {
    parse: (input: unknown) => {
      if (typeof input !== 'object' || input === null) throw new Error('Expected object')
      const { path } = input as { path: unknown }
      if (typeof path !== 'string') throw new Error('path must be string')
      return { path }
    },
    safeParse: (input: unknown) => {
      try {
        const data = input as Record<string, unknown>
        if (typeof data?.path !== 'string') {
          return { success: false }
        }
        return { success: true, data: { path: data.path as string } }
      } catch {
        return { success: false }
      }
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input, _context) {
    const { readFileSync } = await import('fs')
    const content = readFileSync(input.path as string, 'utf-8')
    return { result: { path: input.path, content, size: content.length } }
  },
  renderResult(result: unknown) {
    const r = result as { path: string; content: string; size: number }
    return `Read ${r.path} (${r.size} bytes):\n${r.content.slice(0, 200)}...`
  },
})

/**
 * WriteTool - Write content to a file
 */
export const WriteTool = buildTool({
  name: 'Write',
  description: 'Write content to a file, creating it if it does not exist',
  inputSchema: {
    parse: (input: unknown) => {
      if (typeof input !== 'object' || input === null) throw new Error('Expected object')
      const { path, content } = input as { path: unknown; content: unknown }
      if (typeof path !== 'string') throw new Error('path must be string')
      if (typeof content !== 'string') throw new Error('content must be string')
      return { path, content }
    },
    safeParse: (input: unknown) => {
      try {
        const data = input as Record<string, unknown>
        if (typeof data?.path !== 'string' || typeof data?.content !== 'string') {
          return { success: false }
        }
        return { success: true, data: { path: data.path as string, content: data.content as string } }
      } catch {
        return { success: false }
      }
    },
  },
  isReadOnly: () => false,
  async execute(input, _context) {
    const { writeFileSync, mkdirSync } = await import('fs')
    const path = input.path as string
    const content = input.content as string
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) mkdirSync(dir, { recursive: true })
    writeFileSync(path, content, 'utf-8')
    return { result: { path, bytesWritten: content.length } }
  },
  renderResult(result: unknown) {
    const r = result as { path: string; bytesWritten: number }
    return `Wrote ${r.bytesWritten} bytes to ${r.path}`
  },
})

/**
 * BashTool - Execute a shell command
 */
export const BashTool = buildTool({
  name: 'Bash',
  description: 'Execute a shell command and return the output',
  inputSchema: {
    parse: (input: unknown) => {
      if (typeof input !== 'object' || input === null) throw new Error('Expected object')
      const { command } = input as { command: unknown }
      if (typeof command !== 'string') throw new Error('command must be string')
      return { command }
    },
    safeParse: (input: unknown) => {
      try {
        const data = input as Record<string, unknown>
        if (typeof data?.command !== 'string') {
          return { success: false }
        }
        return { success: true, data: { command: data.command as string } }
      } catch {
        return { success: false }
      }
    },
  },
  isReadOnly: () => false,
  async execute(input, context) {
    if (context.abortSignal.aborted) {
      return { result: { stdout: '', stderr: 'Aborted' } }
    }
    try {
      const { execSync } = await import('child_process')
      const command = input.command as string
      const stdout = String(execSync(command, { encoding: 'utf-8', timeout: 30000 }))
      return { result: { stdout, stderr: '' } }
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string }
      return {
        result: {
          stdout: err.stdout || '',
          stderr: err.stderr || err.message || 'Unknown error',
        }
      }
    }
  },
  renderResult(result: unknown) {
    const r = result as { stdout: string; stderr: string }
    const output = r.stderr || r.stdout
    return `Output:\n${output.slice(0, 500)}`
  },
})

/**
 * GlobTool - Find files matching a glob pattern
 * Note: Uses bash `find` for portability, install `glob` package for full glob support
 */
export const GlobTool = buildTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern',
  inputSchema: {
    parse: (input: unknown) => {
      if (typeof input !== 'object' || input === null) throw new Error('Expected object')
      const { pattern, cwd } = input as { pattern: unknown; cwd: unknown }
      if (typeof pattern !== 'string') throw new Error('pattern must be string')
      return { pattern, cwd: typeof cwd === 'string' ? cwd : '.' }
    },
    safeParse: (input: unknown) => {
      try {
        const data = input as Record<string, unknown>
        if (typeof data?.pattern !== 'string') {
          return { success: false }
        }
        return { success: true, data: { pattern: data.pattern as string, cwd: (data.cwd as string) || '.' } }
      } catch {
        return { success: false }
      }
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input, _context) {
    const { execSync } = await import('child_process')
    const pattern = input.pattern as string
    const cwd = input.cwd as string
    // Convert glob pattern to find command
    const escaped = pattern.replace(/\*/g, '*').replace(/\?/g, '?')
    const output = String(execSync(`find ${cwd} -name "${escaped}" -type f 2>/dev/null | head -100`, { encoding: 'utf-8', timeout: 10000 }))
    const files = output.trim().split('\n').filter(Boolean)
    return { result: { pattern, cwd, files, count: files.length } }
  },
  renderResult(result: unknown) {
    const r = result as { pattern: string; count: number; files: string[] }
    if (r.count === 0) return `No files matched pattern: ${r.pattern}`
    return `Found ${r.count} files matching "${r.pattern}":\n${r.files.slice(0, 20).join('\n')}`
  },
})

/**
 * GrepTool - Search file contents using regular expressions
 */
export const GrepTool = buildTool({
  name: 'Grep',
  description: 'Search for patterns in files using regular expressions',
  inputSchema: {
    parse: (input: unknown) => {
      if (typeof input !== 'object' || input === null) throw new Error('Expected object')
      const { pattern, path, glob, context: ctx, caseInsensitive } = input as Record<string, unknown>
      if (typeof pattern !== 'string') throw new Error('pattern must be string')
      return {
        pattern,
        path: typeof path === 'string' ? path : '.',
        glob: typeof glob === 'string' ? glob : undefined,
        context: typeof ctx === 'number' ? ctx : 0,
        caseInsensitive: caseInsensitive === true,
      }
    },
    safeParse: (input: unknown) => {
      try {
        const data = input as Record<string, unknown>
        if (typeof data?.pattern !== 'string') {
          return { success: false }
        }
        return {
          success: true,
          data: {
            pattern: data.pattern as string,
            path: (data.path as string) || '.',
            glob: data.glob as string | undefined,
            context: (data.context as number) || 0,
            caseInsensitive: data.caseInsensitive === true,
          }
        }
      } catch {
        return { success: false }
      }
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input, _context) {
    const { execSync } = await import('child_process')
    const { pattern, path, glob, context: ctx, caseInsensitive } = input as {
      pattern: string; path: string; glob?: string; context: number; caseInsensitive: boolean
    }

    const args = ['-rn']
    if (ctx > 0) args.push(`-C${ctx}`)
    if (caseInsensitive) args.push('-i')
    if (glob) args.push('--glob', glob)
    args.push(pattern, path)

    try {
      const output = String(execSync(`grep ${args.join(' ')}`, { encoding: 'utf-8', timeout: 30000 }))
      const lines = output.trim().split('\n').filter(Boolean)
      return { result: { pattern, matches: lines, count: lines.length } }
    } catch {
      return { result: { pattern, matches: [], count: 0 } }
    }
  },
  renderResult(result: unknown) {
    const r = result as { pattern: string; count: number; matches: string[] }
    if (r.count === 0) return `No matches found for: ${r.pattern}`
    return `Found ${r.count} matches for "${r.pattern}":\n${r.matches.slice(0, 30).join('\n')}`
  },
})

/**
 * WebFetchTool - Fetch content from a URL
 * Note: Uses native fetch (available in Node 18+)
 */
export const WebFetchTool = buildTool({
  name: 'WebFetch',
  description: 'Fetch content from a URL',
  inputSchema: {
    parse: (input: unknown) => {
      if (typeof input !== 'object' || input === null) throw new Error('Expected object')
      const { url } = input as { url: unknown }
      if (typeof url !== 'string') throw new Error('url must be string')
      return { url }
    },
    safeParse: (input: unknown) => {
      try {
        const data = input as Record<string, unknown>
        if (typeof data?.url !== 'string') {
          return { success: false }
        }
        return { success: true, data: { url: data.url as string } }
      } catch {
        return { success: false }
      }
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input, _context) {
    const url = input.url as string
    const response = await fetch(url, { headers: { 'User-Agent': 'query-loop/1.0' } })
    const content = await response.text()
    return { result: { url, status: response.status, content: content.slice(0, 5000) } }
  },
  renderResult(result: unknown) {
    const r = result as { url: string; status: number; content: string }
    return `[${r.status}] ${r.url}\n${r.content.slice(0, 300)}...`
  },
})

/**
 * Get all built-in tools
 */
export const builtinTools: Tool[] = [
  ReadTool,
  WriteTool,
  BashTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
]
