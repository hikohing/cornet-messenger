/**
 * Errors created here are safe to show to the user verbatim.
 * Anything else (driver errors, bugs) is logged server-side and replaced
 * with a generic message so internals never leak to clients.
 */
export function appError(message, status = 400, code = 'BAD_REQUEST') {
  const err = new Error(message)
  err.expose = true
  err.status = status
  err.code = code
  return err
}

export function publicErrorMessage(err, fallback = 'Не удалось выполнить действие. Попробуйте ещё раз.') {
  if (err && err.expose) return err.message
  console.error('[internal error]', err)
  return fallback
}
