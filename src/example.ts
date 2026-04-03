import { createQueryLoop, buildTool, type ToolContext } from './index.js'

const ReadTool = buildTool({
  name: 'Read',
  description: 'Read contents of a file',
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

const WriteTool = buildTool({
  name: 'Write',
  description: 'Write content to a file',
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

const BashTool = buildTool({
  name: 'Bash',
  description: 'Execute a shell command',
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

async function main() {
  console.log('=== Query Loop Example ===\n')

  const queryLoop = createQueryLoop(
    [ReadTool, WriteTool, BashTool],
    { maxTurns: 5 }
  )

  const prompt = 'Create a file called hello.txt with "Hello, World!" and then read it back'

  console.log(`User: ${prompt}\n`)
  console.log('Assistant:')

  let fullResponse = ''

  for await (const event of queryLoop.query([], prompt)) {
    switch (event.type) {
      case 'assistant':
        fullResponse += event.content
        process.stdout.write(event.content)
        break
      case 'tool_use':
        console.log(`\n[TOOL CALL: ${event.toolCall.name}]`)
        console.log(JSON.stringify(event.toolCall.input, null, 2))
        break
      case 'tool_result':
        console.log(`\n[TOOL RESULT]: ${event.result.content.slice(0, 100)}...`)
        break
      case 'turn_end':
        console.log(`\n[Turn ${event.turnCount} complete]`)
        break
      case 'complete':
        console.log(`\n\n=== FINAL RESPONSE ===\n${event.finalContent}`)
        break
    }
  }

  console.log('\n=== Query Loop Stats ===')
  console.log(`Total messages: ${queryLoop.getMessages().length}`)
  console.log(`Abort method available:`, typeof queryLoop.abort === 'function')
}

main().catch(console.error)
