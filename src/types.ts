export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG"

export type Log = (level: LogLevel, ...args: unknown[]) => void

export type ToolSchema = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ToolContent = {
  type: "text"
  text: string
}

export type ToolResultPayload = {
  content: ToolContent[]
  isError?: boolean
}

export type MCPPermissions = {
  read: boolean
  write: boolean
}

export type HelloMessage = {
  v: string
  type: "hello"
  token: string
  userAgent: string
  expectedBridgeVersion: string
  consoleOrigin: string
  tools: ToolSchema[]
  permissions: MCPPermissions
}

export type HelloAckMessage = {
  v: string
  type: "hello_ack"
  sessionId: string
  heartbeatIntervalMs: number
  seenToolCount: number
}

export type ToolCallMessage = {
  v: string
  type: "tool_call"
  requestId: string
  name: string
  arguments: Record<string, unknown>
  deadlineMs: number | null
}

export type ToolResultMessage = {
  v: string
  type: "tool_result"
  requestId: string
  content: ToolContent[]
  isError?: boolean
}

export type PingMessage = {
  v: string
  type: "ping"
  nonce: string
}

export type PongMessage = {
  v: string
  type: "pong"
  nonce: string
}

export type CancelMessage = {
  v: string
  type: "cancel"
  requestId: string
}

export const WS_CLOSE_CODES = {
  superseded: 4001,
  token_invalid: 4002,
  major_version_mismatch: 4004,
  protocol_violation: 4005,
  user_disconnect: 4006,
  tab_closing: 4007,
} as const

export type AnyMessage =
  | HelloMessage
  | HelloAckMessage
  | ToolCallMessage
  | ToolResultMessage
  | PingMessage
  | PongMessage
  | CancelMessage
