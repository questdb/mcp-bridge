import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { dirname, join as joinPath } from "node:path"
import type { Log, LogLevel } from "./types.js"

const DEFAULT_LOG_DIR = "/tmp/questdb-mcp-bridge"
const MAX_LOG_FILES = 10

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
}

const safeISOTimestamp = (): string => {
  try {
    return new Date().toISOString().replace(/[:.]/g, "-")
  } catch {
    return `${Date.now()}`
  }
}

export class Logger {
  private filePath: string | null = null
  private levelThreshold: number = LOG_LEVEL_ORDER.INFO

  constructor() {
    this.initLevel()
    this.initFile()
  }

  log: Log = (level, ...args) => {
    if (!this.isLevelEnabled(level)) return
    const body = args.map(this.formatArg).join(" ")
    const line = this.formatLine(level, body)
    this.writeStderrSync(line)
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line)
      } catch (err) {
        const failedPath = this.filePath
        this.filePath = null
        this.writeStderrSync(
          this.formatLine(
            "ERROR",
            `log file ${failedPath} write failed (${
              err instanceof Error ? err.message : String(err)
            }); disabled`,
          ),
        )
      }
    }
  }

  fatal = (msg: string, code = 1): never => {
    const line = this.formatLine("ERROR", `FATAL: ${msg}`)
    this.writeStderrSync(line)
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line)
      } catch (err) {
        void err
      }
    }
    process.exit(code)
  }

  getFilePath(): string | null {
    return this.filePath
  }

  getLevelName(): LogLevel {
    for (const [name, ord] of Object.entries(LOG_LEVEL_ORDER) as [
      LogLevel,
      number,
    ][]) {
      if (ord === this.levelThreshold) return name
    }
    return "INFO"
  }

  private isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] <= this.levelThreshold
  }

  private formatLine(level: LogLevel, body: string): string {
    return `${new Date().toISOString()} [${level}] ${body}\n`
  }

  private formatArg = (a: unknown): string => {
    if (a instanceof Error) return a.stack ?? a.message
    if (typeof a === "string") return a
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }

  private writeStderrSync(line: string): void {
    try {
      writeSync(process.stderr.fd, line)
    } catch (err) {
      void err
    }
  }

  private initLevel(): void {
    const raw = process.env.LOG_LEVEL
    if (raw === undefined || raw === "") return
    const upper = raw.toUpperCase()
    if (upper in LOG_LEVEL_ORDER) {
      this.levelThreshold = LOG_LEVEL_ORDER[upper as LogLevel]
      return
    }
    this.writeStderrSync(
      this.formatLine(
        "INFO",
        `LOG_LEVEL=${raw} is not a valid log level. Valid levels are: ${Object.keys(LOG_LEVEL_ORDER).join(", ")}. Defaulting to INFO`,
      ),
    )
  }

  private buildDefaultPath(): string {
    return joinPath(
      DEFAULT_LOG_DIR,
      `${safeISOTimestamp()}-${process.pid}.log`,
    )
  }

  private tryOpenFile(path: string): Error | null {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, "")
      return null
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }

  private pruneOldFiles(): void {
    try {
      const entries = readdirSync(DEFAULT_LOG_DIR)
        .filter((name) => name.endsWith(".log"))
        .map((name) => {
          const full = joinPath(DEFAULT_LOG_DIR, name)
          try {
            return { full, mtime: statSync(full).mtimeMs }
          } catch {
            return null
          }
        })
        .filter((e): e is { full: string; mtime: number } => e !== null)
        .sort((a, b) => b.mtime - a.mtime)
      for (const old of entries.slice(MAX_LOG_FILES)) {
        try {
          unlinkSync(old.full)
        } catch (err) {
          void err
        }
      }
    } catch (err) {
      void err
    }
  }

  private initFile(): void {
    try {
      const candidates: string[] = []
      const requested = process.env.LOG_PATH
      if (requested && requested.length > 0) candidates.push(requested)
      candidates.push(this.buildDefaultPath())
      const failures: string[] = []
      for (const path of candidates) {
        const err = this.tryOpenFile(path)
        if (!err) {
          if (failures.length > 0) {
            this.writeStderrSync(
              this.formatLine(
                "WARN",
                `log file fallback (${failures.join("; ")}) → using ${path}`,
              ),
            )
          }
          this.filePath = path
          if (dirname(path) === DEFAULT_LOG_DIR) {
            this.pruneOldFiles()
          }
          return
        }
        failures.push(`${path}: ${err.message}`)
      }
      this.writeStderrSync(
        this.formatLine(
          "ERROR",
          `log file disabled — all candidates failed: ${failures.join(
            "; ",
          )}; stderr only`,
        ),
      )
    } catch (err) {
      this.writeStderrSync(
        this.formatLine(
          "ERROR",
          `initFile crashed: ${
            err instanceof Error ? err.message : String(err)
          }; stderr only`,
        ),
      )
    }
  }
}
