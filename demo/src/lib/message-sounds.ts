export type MessageSoundSettings = { enabled: boolean; volume: number };
const DEFAULTS: MessageSoundSettings = { enabled: true, volume: 0.4 };
const PREFIX = 'tongpin-message-sounds:';
const COOLDOWN_MS = 1200;
const fallback = new Map<string, MessageSoundSettings>();
let context: AudioContext | null = null;
let activeUser: string | null = null;
let generation = 0;
let lastPlayed = -Infinity;
const recent = new Set<string>();
const tones = new Set<OscillatorNode>();

export function messageSoundsSupported(): boolean { return typeof window !== 'undefined' && typeof window.AudioContext === 'function'; }
export function messageSoundSettings(userId: string): MessageSoundSettings {
  if (fallback.has(userId)) return fallback.get(userId)!;
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + userId) || 'null');
    if (value && typeof value.enabled === 'boolean' && typeof value.volume === 'number' && Number.isFinite(value.volume)) return { enabled: value.enabled, volume: Math.min(1, Math.max(0, value.volume)) };
  } catch { /* Storage may be unavailable; retain this page's preference. */ }
  return { ...DEFAULTS };
}
function stopTones() { for (const oscillator of tones) { try { oscillator.stop(); } catch { /* Already ended. */ } } tones.clear(); }
export function setMessageSoundSettings(userId: string, patch: Partial<MessageSoundSettings>): MessageSoundSettings {
  const previous = messageSoundSettings(userId);
  const value = { enabled: patch.enabled ?? previous.enabled, volume: typeof patch.volume === 'number' && Number.isFinite(patch.volume) ? Math.min(1, Math.max(0, patch.volume)) : previous.volume };
  try { localStorage.setItem(PREFIX + userId, JSON.stringify(value)); fallback.delete(userId); }
  catch { fallback.set(userId, value); while (fallback.size > 20) fallback.delete(fallback.keys().next().value!); }
  if (activeUser === userId && (!value.enabled || !value.volume)) stopTones();
  if (activeUser === userId && patch.enabled === true) unlock();
  window.dispatchEvent(new CustomEvent('tongpin:message-sounds-changed', { detail: { userId } }));
  return value;
}

/** Called inside page gestures; never queue an old message while waiting for autoplay permission. */
function unlock(): AudioContext | null {
  if (!messageSoundsSupported()) return null;
  try {
    if (!context || context.state === 'closed') context = new window.AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    return context;
  } catch { return null; }
}

function chime(audio: AudioContext, volume: number): boolean {
  if (audio.state !== 'running' || volume <= 0) return false;
  try {
    stopTones();
    // Short sine tones with a smooth envelope avoid clicks and loud transients.
    for (const [offset, frequency] of [[0, 784], [0.13, 1046.5]]) {
      const oscillator = audio.createOscillator(), gain = audio.createGain();
      const start = audio.currentTime + offset + 0.01;
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume * 0.18, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      gain.gain.linearRampToValueAtTime(0, start + 0.25);
      oscillator.connect(gain); gain.connect(audio.destination); tones.add(oscillator);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); tones.delete(oscillator); };
      oscillator.start(start); oscillator.stop(start + 0.26);
    }
    return true;
  } catch { stopTones(); return false; }
}

export function startMessageSounds(userId: string): () => void {
  stopTones();
  const epoch = ++generation; activeUser = userId; recent.clear(); lastPlayed = -Infinity;
  const gesture = () => { if (generation === epoch && messageSoundSettings(userId).enabled) unlock(); };
  const changed = (event: StorageEvent) => { if (event.key === null || event.key === PREFIX + userId) { fallback.delete(userId); const value = messageSoundSettings(userId); if (!value.enabled || !value.volume) stopTones(); } };
  window.addEventListener('pointerdown', gesture, { capture: true, passive: true });
  window.addEventListener('click', gesture, true);
  window.addEventListener('keydown', gesture, true); window.addEventListener('storage', changed);
  return () => {
    window.removeEventListener('pointerdown', gesture, true); window.removeEventListener('click', gesture, true); window.removeEventListener('keydown', gesture, true); window.removeEventListener('storage', changed);
    if (generation !== epoch) return;
    generation++; activeUser = null; stopTones(); recent.clear();
    const previous = context; context = null; if (previous && previous.state !== 'closed') void previous.close().catch(() => undefined);
  };
}

export async function previewMessageSound(userId: string): Promise<boolean> {
  if (activeUser !== userId) return false;
  const epoch = generation, audio = unlock(); if (!audio) return false;
  try { if (audio.state !== 'running') await audio.resume(); } catch { return false; }
  return generation === epoch && activeUser === userId && chime(audio, messageSoundSettings(userId).volume);
}

/** Only live, authorized incoming messages reach this function; recheck after cross-tab arbitration. */
export async function playMessageSound(userId: string, messageId: string, allowed: () => boolean): Promise<boolean> {
  if (activeUser !== userId || !allowed() || recent.has(messageId)) return false;
  const epoch = generation;
  recent.add(messageId); while (recent.size > 128) recent.delete(recent.values().next().value!);
  const preference = messageSoundSettings(userId);
  if (!preference.enabled || !preference.volume || context?.state !== 'running') return false;
  const play = () => {
    const preference = messageSoundSettings(userId), now = Date.now();
    if (activeUser !== userId || generation !== epoch || !allowed() || !preference.enabled || !preference.volume || context?.state !== 'running' || now - lastPlayed < COOLDOWN_MS) return false;
    const key = PREFIX + 'recent:' + userId;
    let ids: string[] = [];
    try {
      const record = JSON.parse(localStorage.getItem(key) || 'null');
      if (record && Array.isArray(record.ids)) ids = record.ids.filter((id: unknown) => typeof id === 'string').slice(-127);
      if (ids.includes(messageId) || record && typeof record.at === 'number' && now - record.at >= 0 && now - record.at < COOLDOWN_MS) return false;
    } catch { /* Per-page throttling still applies without storage. */ }
    if (!chime(context, preference.volume)) return false;
    lastPlayed = now;
    try { localStorage.setItem(key, JSON.stringify({ at: now, ids: [...ids, messageId] })); } catch { /* Best effort cross-tab deduplication. */ }
    return true;
  };
  try {
    if (navigator.locks?.request) return await navigator.locks.request(PREFIX + userId, { ifAvailable: true }, (lock) => lock ? play() : false);
  } catch { /* Older browsers and file-based demos may not expose Web Locks. */ }
  return play();
}
