// No dependencies: unit-tested on the host, used by index.mjs inside dsh-main.
const TRANSIENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ETIMEDOUT'])

/**
 * Run `attempt` until it succeeds, retrying only network errors a container that is
 * still booting produces (its launcher not listening yet), for at most `timeoutMs`.
 * Any other error, or the deadline, fails at once. `onWait(code)` fires on the first retry.
 */
export async function retryTransient(attempt, { timeoutMs, intervalMs = 200, onWait = () => {} }) {
  const deadline = Date.now() + timeoutMs
  for (let waited = false; ; waited = true) {
    try {
      return await attempt()
    } catch (error) {
      if (!TRANSIENT.has(error?.code) || Date.now() + intervalMs > deadline) throw error
      if (!waited) onWait(error.code)
      await new Promise(r => setTimeout(r, intervalMs))
    }
  }
}
