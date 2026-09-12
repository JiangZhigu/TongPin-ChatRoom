export const demoOrigin = 'http://tongpin.demo';
export function demoPath() { return window.location.hash.startsWith('#/') ? window.location.hash.slice(1) : '/'; }
export function demoSearch() { const path = demoPath(); return path.includes('?') ? '?' + path.split('?').slice(1).join('?') : ''; }
const push = history.pushState.bind(history); const replace = history.replaceState.bind(history);
function normalized(value?: string | URL | null) { const text = String(value || '/'); if (text.startsWith('#')) return text; const parsed = new URL(text, demoOrigin); return '#' + parsed.pathname + parsed.search + parsed.hash; }
history.pushState = (data, unused, url) => { push(data, unused, normalized(url)); window.dispatchEvent(new Event('demo:navigation')); };
history.replaceState = (data, unused, url) => { replace(data, unused, normalized(url)); };
export function navigate(path: string) { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
document.addEventListener('click', event => { if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey) return; const link = (event.target as Element)?.closest<HTMLAnchorElement>('a[href]'); const href = link?.getAttribute('href'); if (href?.startsWith('#') && !href.startsWith('#/') && !href.startsWith('#invite=')) { const target = document.getElementById(href.slice(1)); if (target) { event.preventDefault(); target.focus(); target.scrollIntoView(); } return; } if (!link || link.download || !href?.startsWith('/')) return; event.preventDefault(); navigate(href); });
window.addEventListener('hashchange', () => { window.dispatchEvent(new Event('demo:navigation')); window.dispatchEvent(new PopStateEvent('popstate')); });
