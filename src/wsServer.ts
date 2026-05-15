import { createServer, type IncomingMessage, type Server } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import { tokensMatch } from "./sessionStore.js"
import { WS_CLOSE_CODES, type AnyMessage, type Log } from "./types.js"
import type { BridgeSession, BrowserConn } from "./bridgeSession.js"

type WsServerConfig = {
  port: number
  token: string
  allowedOrigins: string[]
  session: BridgeSession
  log?: Log
  onFatalError?: (kind: FatalErrorKind, err: Error) => void
}

export type FatalErrorKind = "fd-exhaustion"

const safeWrite = (
  socket: { write: (data: string) => unknown },
  data: string,
): void => {
  try {
    socket.write(data)
  } catch (err) {
    void err
  }
}

export class InvalidConsoleOriginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidConsoleOriginError"
  }
}

export const deriveAllowedOrigins = (consoleOrigin: string): string[] => {
  let parsed: URL
  try {
    parsed = new URL(consoleOrigin)
  } catch {
    throw new InvalidConsoleOriginError(
      `CONSOLE_ORIGIN=${consoleOrigin} is not a valid URL.`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidConsoleOriginError(
      `CONSOLE_ORIGIN=${consoleOrigin} must use http:// or https://.`,
    )
  }
  const result = new Set<string>([parsed.origin])
  const loopbackHosts = new Set(["127.0.0.1", "localhost"])
  const normalizedHost = parsed.hostname.toLowerCase()
  if (loopbackHosts.has(normalizedHost)) {
    for (const alt of loopbackHosts) {
      if (alt === normalizedHost) continue
      const url = new URL(parsed.origin)
      url.hostname = alt
      result.add(url.origin)
    }
  }
  return Array.from(result)
}

const isOriginAllowed = (
  origin: string | undefined,
  allowed: string[],
): boolean => {
  if (!origin) return false
  return allowed.includes(origin)
}

const extractToken = (req: IncomingMessage): string | null => {
  if (!req.url) return null
  const url = new URL(req.url, "http://placeholder")
  return url.searchParams.get("token")
}

const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const WS_OUTBOUND_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024

export const startWsServer = (config: WsServerConfig) => {
  const httpServer: Server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("This server only accepts WebSocket connections.\n")
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  })

  httpServer.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      safeWrite(
        socket,
        "HTTP/1.1 403 Forbidden\r\n" +
          "Connection: close\r\n" +
          "Content-Type: text/plain\r\n" +
          "\r\n" +
          "Origin not allowed: must match CONSOLE_ORIGIN.\n",
      )
      socket.destroy()
      return
    }
    const token = extractToken(req)
    if (!token || !tokensMatch(token, config.token)) {
      safeWrite(
        socket,
        "HTTP/1.1 401 Unauthorized\r\n" +
          "Connection: close\r\n" +
          "Content-Type: text/plain\r\n" +
          "\r\n" +
          "Token missing or invalid.\n",
      )
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req)
    })
  })

  wss.on("connection", (ws: WebSocket) => {
    const conn: BrowserConn = {
      send: (msg: AnyMessage) => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount > WS_OUTBOUND_BUFFER_LIMIT_BYTES) {
          config.log?.(
            "WARN",
            `outbound buffer overflow (${ws.bufferedAmount} bytes); terminating`,
          )
          try {
            ws.terminate()
          } catch (err) {
            void err
          }
          return
        }
        ws.send(JSON.stringify(msg))
      },
      close: (code: number, reason: string) => {
        try {
          ws.close(code, reason)
        } catch (err) {
          void err
        }
      },
      terminate: () => {
        try {
          ws.terminate()
        } catch (err) {
          void err
        }
      },
    }

    ws.on("error", (err) => {
      void err
    })

    const accept = config.session.attachBrowser(conn)
    if (accept === "superseded") {
      ws.close(WS_CLOSE_CODES.superseded, "another_browser_connected")
      return
    }

    ws.on("message", (data) => {
      let parsed: AnyMessage
      try {
        let text: string
        if (typeof data === "string") {
          text = data
        } else if (Buffer.isBuffer(data)) {
          text = data.toString("utf-8")
        } else if (Array.isArray(data)) {
          text = Buffer.concat(data).toString("utf-8")
        } else {
          text = Buffer.from(data).toString("utf-8")
        }
        parsed = JSON.parse(text) as AnyMessage
      } catch {
        ws.close(WS_CLOSE_CODES.protocol_violation, "malformed_json")
        return
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { type?: unknown }).type !== "string" ||
        typeof (parsed as { v?: unknown }).v !== "string"
      ) {
        ws.close(WS_CLOSE_CODES.protocol_violation, "malformed_message")
        return
      }
      config.session.handleMessage(parsed)
    })
    ws.on("close", () => {
      config.session.handleSocketClose(conn)
    })
  })

  return new Promise<{ stop: () => Promise<void> }>((resolve, reject) => {
    const onBindError = (err: Error): void => {
      try {
        wss.close()
      } catch (e) {
        void e
      }
      try {
        httpServer.close()
      } catch (e) {
        void e
      }
      reject(err)
    }
    httpServer.once("error", onBindError)
    httpServer.listen(config.port, "127.0.0.1", () => {
      httpServer.removeListener("error", onBindError)
      httpServer.on("error", (err) => {
        const code = (err as Error & { code?: string }).code
        if (code === "EMFILE" || code === "ENFILE") {
          config.log?.(
            "ERROR",
            `httpServer FATAL: ${code} (file descriptor exhaustion).`,
          )
          if (config.onFatalError) {
            config.onFatalError("fd-exhaustion", err)
            return
          }
          config.log?.(
            "WARN",
            "  No onFatalError handler registered; continuing in degraded state.",
          )
          return
        }
        config.log?.("ERROR", "httpServer runtime error:", err)
      })
      resolve({
        stop: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) {
              try {
                client.terminate()
              } catch (e) {
                void e
              }
            }
            httpServer.closeAllConnections?.()
            wss.close(() => {
              httpServer.close(() => res())
            })
          }),
      })
    })
  })
}
