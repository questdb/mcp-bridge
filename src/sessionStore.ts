import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:net"

export const generateToken = (): string =>
  randomBytes(16).toString("base64url")

export const tokensMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

export const findFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (typeof addr === "object" && addr !== null && "port" in addr) {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        server.close()
        reject(new Error("could not obtain free port"))
      }
    })
  })
}
