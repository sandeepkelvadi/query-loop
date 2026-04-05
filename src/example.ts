import { createQueryLoop, builtinTools, createAnthropicAdapter, createSecurePermissionSystem } from './index.js'

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('Please set ANTHROPIC_API_KEY environment variable')
    console.log('Usage: ANTHROPIC_API_KEY=sk-ant-... npm run example')
    process.exit(1)
  }

  console.log('=== Query Loop with Permission System ===\n')

  const adapter = createAnthropicAdapter({ apiKey })
  const permissions = createSecurePermissionSystem()

  console.log('Permission System: Secure mode (only safe tools allowed by default)\n')

  const queryLoop = createQueryLoop(builtinTools, {
    maxTurns: 5,
    permissionSystem: permissions,
  }, adapter)

  const prompt = 'List files in the current directory using Bash'
  console.log(`User: ${prompt}\n`)
  console.log('Assistant (streaming):\n')

  let fullResponse = ''

  for await (const event of queryLoop.query([], prompt)) {
    switch (event.type) {
      case 'assistant':
        fullResponse = event.content
        break
      case 'assistant_delta':
        fullResponse += event.delta
        process.stdout.write(event.delta)
        break
      case 'tool_use':
        console.log(`\n\n[TOOL CALL: ${event.toolCall.name}]`)
        break
      case 'tool_progress':
        console.log(`[PROGRESS]: ${event.content.slice(0, 50)}...`)
        break
      case 'tool_denied':
        console.log(`\n[DENIED]: ${event.reason}`)
        break
      case 'tool_result':
        console.log(`[TOOL RESULT]: ${event.result.content.slice(0, 100)}...`)
        break
      case 'turn_end':
        console.log('\n[Turn complete]')
        break
      case 'complete':
        console.log(`\n\n=== DONE ===`)
        console.log(`Final response: ${event.finalContent.slice(0, 100)}...`)
        break
    }
  }

  console.log(`\nTotal messages: ${queryLoop.getMessages().length}`)
}

main().catch(console.error)
