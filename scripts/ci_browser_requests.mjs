// CI-only evidence for intentional cancellation; never loaded by the application.
const navigationPath = '/api/v1/account/navigation';
const correlationHeader = 'x-tongpin-ci-request';

export async function observeRequests(page, { origin, isClosing = () => false }) {
  const aborted = new Set();
  const pending = new Set();
  const failures = [];
  let navigating = false;
  const eligible = (request) => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.origin === origin && url.pathname === navigationPath;
  };
  await page.exposeBinding('__tongpinCiAborted', (_source, id) => { aborted.add(id); });
  await page.addInitScript(({ origin, navigationPath, correlationHeader }) => {
    const nativeFetch = window.fetch;
    const documentId = crypto.randomUUID();
    let sequence = 0;
    const deliveries = [];
    window.__tongpinCiFlushAborts = () => Promise.all(deliveries);
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin !== origin || url.pathname !== navigationPath || method !== 'GET') return nativeFetch.call(this, input, init);
      const request = new Request(input, init);
      const id = `${documentId}:${++sequence}`;
      request.headers.set(correlationHeader, id);
      const recordAbort = () => { deliveries.push(window.__tongpinCiAborted(id)); };
      if (request.signal.aborted) recordAbort();
      else request.signal.addEventListener('abort', recordAbort, { once: true });
      return nativeFetch.call(this, request);
    };
  }, { origin, navigationPath, correlationHeader });
  page.on('request', (request) => { pending.add(request); });
  page.on('requestfinished', (request) => { pending.delete(request); });
  page.on('requestfailed', (request) => {
    pending.delete(request);
    failures.push({ request, closing: isClosing(), navigation: navigating && request.isNavigationRequest() });
  });
  return {
    beginNavigation() {
      navigating = true;
    },
    endNavigation() { navigating = false; },
    pendingReads() { return [...pending].filter(eligible).length; },
    async collect() {
      // Wait for page-to-runner abort evidence before classifying network events.
      if (!page.isClosed()) await page.evaluate(() => window.__tongpinCiFlushAborts?.());
      return failures.splice(0).map(({ request, closing, navigation }) => {
        const message = request.failure()?.errorText || 'unknown';
        let reason = null;
        if (closing) reason = 'browser-shutdown';
        else if (message === 'net::ERR_ABORTED') {
          if (navigation) reason = 'scripted-navigation';
          else if (eligible(request)) {
            if (aborted.has(request.headers()[correlationHeader])) reason = 'application-abort-signal';
          }
        }
        return { kind: 'requestfailed', path: new URL(request.url()).pathname, message, ...(reason ? { reason } : {}) };
      });
    },
  };
}
