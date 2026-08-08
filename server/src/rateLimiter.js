/**
 * Token bucket: держит до `capacity` токенов, восполняется на `refillPerSec`
 * каждую секунду. Используется для троттлинга WS-сообщений на соединение,
 * где express-rate-limit (HTTP-миддлварь) неприменим.
 */
export function createTokenBucket({ capacity, refillPerSec }) {
  let tokens = capacity
  let last = Date.now()
  return {
    take(cost = 1) {
      const now = Date.now()
      tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec)
      last = now
      if (tokens < cost) return false
      tokens -= cost
      return true
    },
  }
}
