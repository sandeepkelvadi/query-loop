import { createQueryLoop, builtinTools } from './index.js'

async function main() {
  console.log('=== Query Loop Example ===\n')

  const queryLoop = createQueryLoop(builtinTools, { maxTurns: 5 })

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
