export function startSelectedViewerScheduler(options: {
  idle: () => boolean;
  check: () => Promise<{available: boolean}>;
  install: () => Promise<void>;
  report: (error: unknown) => void;
}) {
  let disposed = false;
  let busy = false;
  let submitted = false;
  let lastCheck = -Infinity;
  const tick = async () => {
    if (disposed || busy || submitted || !options.idle() || Date.now() - lastCheck < 3600000) return;
    busy = true; lastCheck = Date.now();
    try {
      const result = await options.check();
      if (!disposed && options.idle() && result.available) {
        submitted = true;
        await options.install();
      }
    } catch (error) { submitted = false; if (!disposed) options.report(error); }
    finally { busy = false; }
  };
  // The startup delay avoids StrictMode's discarded mount and defers to auth/session recovery.
  const initial = setTimeout(() => void tick(), 10000);
  const timer = setInterval(() => void tick(), 60000);
  return {
    stop: () => { disposed = true; clearTimeout(initial); clearInterval(timer); },
    installationFailed: () => {
      if (disposed || !submitted) return;
      submitted = false;
      lastCheck = Date.now();
    },
  };
}
