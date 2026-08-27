import { setTimeout as delay } from 'node:timers/promises';

export async function waitFor(description, check, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

export async function waitForHttp(url, { requestTimeoutMs = 5_000, ...options } = {}) {
  await waitFor(url, async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    return response.ok;
  }, options);
}
