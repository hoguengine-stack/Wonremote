interface WaitForApiHealthOptions {
  apiBaseUrl: string;
  attempts?: number;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForApiHealth({
  apiBaseUrl,
  attempts = 15,
  fetchImpl = fetch,
  intervalMs = 1000,
  sleep = defaultSleep,
}: WaitForApiHealthOptions): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(`${apiBaseUrl}/api/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Retry until the local API server has finished binding its port.
    }

    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }

  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
