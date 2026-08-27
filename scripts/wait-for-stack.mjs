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
    // AbortSignal.timeout() uses an unref'ed timer. During a Docker port
    // recreation on Windows that can leave top-level await as the only pending
    // work, causing Node to exit with code 13 instead of continuing to poll.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      await response.arrayBuffer();
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  }, options);
}
