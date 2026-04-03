# Query Loop

A minimal, portable implementation of an async generator-based query loop for LLM applications with tool calling.

Based on the architecture patterns from Claude Code's query engine.

## Architecture

```
User Input → Query Loop (async generator)
                ↓
         ┌──────────────────────────────┐
         │   while (true) {             │
         │     1. Pre-process context   │
         │     2. Stream from LLM       │
         │     3. Extract tool calls     │
         │     4. Execute tools          │
         │     5. Check termination      │
         │     6. Loop or exit           │
         └──────────────────────────────┘
                ↓
           Final Response
```

## Key Patterns

### 1. Async Generator Streaming

Messages are yielded as they arrive for real-time UI updates:

```typescript
async function* queryLoop(messages: Message[]) {
  for await (const event of model.stream(messages)) {
    yield event  // Real-time yield
  }
}
```

### 2. Turn-Based Execution

Each LLM response + tool execution = one turn:

```typescript
let turnCount = 0
while (turnCount < maxTurns) {
  const response = await model.complete(messages)
  messages.push(response)
  
  const toolCalls = extractToolCalls(response)
  if (toolCalls.length === 0) break  // Done
  
  const results = await executeTools(toolCalls)
  messages.push(...results)
  turnCount++
}
```

### 3. Tool Orchestration

Tools are partitioned by safety and executed accordingly:

```typescript
// Read-only tools run in parallel
// Write/destructive tools run serially
```

### 4. State Management

A minimal reactive store:

```typescript
function createStore<T>(initialState: T) {
  let state = initialState
  const listeners = new Set<() => void>()
  
  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state)
      if (Object.is(next, prev)) return
      state = next
      listeners.forEach(l => l())
    },
    subscribe: (listener) => () => listeners.delete(listener)
  }
}
```

## Usage

```bash
npm install
npm run build
npm run example
```

## License

MIT
