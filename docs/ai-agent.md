# AI Agent Chat

The Agent Chat is a built-in AI assistant in the right sidebar that helps users create visualizations via natural language.

## Architecture

```
User types a message
  → System prompt + conversation + tool definitions sent to OpenAI-compatible API
  → Model responds with tool_calls → executed locally via React hooks
  → Tool results appended to conversation → API called again
  → Repeat until model responds with final text
  → Response displayed with markdown rendering
```

All processing happens client-side in the browser. No server-side or Electron code is involved. The user's API key is stored in localStorage and calls go directly from the browser to the configured endpoint.

## Configuration

In Settings → General → AI Agent:

| Field | Description | Example |
|-------|-------------|---------|
| API Endpoint | OpenAI-compatible chat completions URL | `https://api.openai.com/v1` |
| API Key | Bearer token for authentication | `sk-...` |
| Model | Model identifier | `gpt-4o`, `claude-sonnet-4-20250514`, etc. |

Works with any OpenAI-compatible API: OpenAI, Anthropic (via proxy), Ollama, vLLM, LiteLLM, Azure OpenAI, etc.

## Tools Available to the Agent

| Tool | Description |
|------|-------------|
| `list_topics` | List all available topics with schema names |
| `search_topics` | Fuzzy search topics by name or schema type |
| `get_topic_fields` | Get all plottable field paths for a specific topic (recursive schema introspection) |
| `search_topic_fields` | Search all topics for fields matching a query (e.g. "acceleration", "temperature") |
| `get_panel_types` | List available panel types (3D, Image, Plot, etc.) |
| `get_current_layout` | Get current mosaic layout tree and panel configs |
| `add_panel` | Add a single panel with config to the layout |
| `set_layout` | Replace the entire layout (arrange multiple panels) |

## Key Files

```
packages/studio-base/src/components/AgentChat/
├── index.tsx              # React UI component (chat bubbles, input, send)
├── agentLoop.ts           # Core loop: API call → tool execution → repeat
├── agentLoop.test.ts      # Tests for the agent loop
├── toolExecutor.ts        # Maps tool names to Studio layout/topic actions
├── toolExecutor.test.ts   # Tests for tool execution
├── toolDefinitions.ts     # JSON schema definitions sent to the LLM
├── toolDefinitions.test.ts
├── systemPrompt.ts        # Builds the system prompt with panel docs
├── systemPrompt.test.ts
├── parseMarkdown.ts       # Minimal markdown→HTML renderer (XSS-safe)
├── parseMarkdown.test.ts
├── types.ts               # Shared types (ChatMessage, ToolCall, etc.)
└── agent-avatar.svg       # Agent avatar icon
```

## Topic Naming Convention

Topic names come directly from the data source:
- **ROS topics** have a leading `/` (e.g. `/camera/image`)
- **MCAP/Foxglove WebSocket topics** often do NOT have a leading `/` (e.g. `sick1/image`)

**MessagePath syntax** (used by Plot, RawMessages panels) uses the topic name as-is:
- Topic `sensors/imu` → Plot path `sensors/imu.linear_acceleration.x` (no added slash)
- Topic `/odom` → Plot path `/odom.pose.position.x` (slash is part of the topic name)

The parser (`@foxglove/message-path`) handles both slashed and unslashed topic names.
The rule: use the EXACT topic name from the data source, do NOT prepend a `/`.

## Example Queries

- "Show me the sick1 camera and a plot of plc virtmaster side by side"
- "What vibration topics are available?"
- "Plot alert_acc_peak from all vibration sensors"
- "Create a 3-panel layout: 3D view on the left, camera top-right, IMU plot bottom-right"

## TODOs

### Security & Guardrails

- [ ] **API key handling**: Consider encrypting the API key in localStorage rather than storing in plaintext
- [ ] **Rate limiting**: Add client-side rate limiting to prevent excessive API calls (accidental loops, rapid typing)
- [ ] **Token budget**: Track token usage per conversation and warn/stop when approaching limits
- [ ] **Input sanitization**: Validate tool arguments more strictly before executing layout changes (e.g. panel type must be in known list)
- [ ] **Confirmation for destructive actions**: `set_layout` replaces the entire layout — consider asking user confirmation before executing
- [ ] **Content filtering**: Optionally filter/block tool calls that seem unrelated to visualization
- [ ] **Error boundaries**: Wrap the agent chat in a React error boundary so failures don't crash the app
- [ ] **Abort in-flight requests**: Add a "Stop" button that aborts the current fetch and stops the tool loop

### Data Analysis Tool

- [ ] **Read MCAP data tool**: Add a tool that can read actual message data from the current player (last N messages on a topic) and return summary statistics (min, max, mean, count, time range)
- [ ] **Schema-aware analysis**: The agent should be able to answer "what happened in the last 3 minutes on vibration sensors" by reading recent data and summarizing
- [ ] **Time-range queries**: Allow the agent to query messages within a specific time window
- [ ] **Anomaly detection**: Simple threshold-based anomaly detection the agent can invoke ("find spikes in acceleration above 5g")

### UX Improvements

- [ ] **Streaming responses**: Use SSE streaming to show text as it arrives (currently waits for full response)
- [ ] **Conversation persistence**: Save chat history to localStorage so it survives page reloads
- [ ] **Clear chat button**: Allow users to reset the conversation
- [ ] **Tool execution indicators**: Show which tools are being called while the agent is thinking
- [ ] **Suggested prompts**: Show example queries when the chat is empty
- [ ] **Keyboard shortcut**: Add a shortcut to focus the agent input (e.g. Cmd+K)
