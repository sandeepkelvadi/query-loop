import { createQueryLoop, builtinTools, createAnthropicAdapter } from './index.js'

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('Please set ANTHROPIC_API_KEY environment variable')
    console.log('Usage: ANTHROPIC_API_KEY=sk-ant-... npm run example')
    process.exit(1)
  }

  console.log('=== Query Loop with Anthropic Adapter ===\n')

  const adapter = createAnthropicAdapter({ apiKey })
  const queryLoop = createQueryLoop(builtinTools, { maxTurns: 5 }, adapter)

  const prompt = 'Say hello and tell me the current date'
  console.log(`User: ${prompt}\n`)
  console.log('Assistant:\n')

  let fullResponse = ''

  for await (const event of queryLoop.query([], prompt)) {
    switch (event.type) {
      case 'assistant':
        fullResponse += event.content
        process.stdout.write(event.content)
        break
      case 'tool_use':
        console.log(`\n[TOOL CALL: ${event.toolCall.name}]`)
        break
      case 'tool_result':
        console.log(`\n[TOOL RESULT]: ${event.result.content.slice(0, 100)}...`)
        break
      case 'turn_end':
        console.log('\n[Turn complete]')
        break
      case 'complete':
        console.log(`\n\n=== DONE ===`)
        break
    }
  }

  console.log(`\nTotal messages: ${queryLoop.getMessages().length}`)
}

main().catch(console.error)
