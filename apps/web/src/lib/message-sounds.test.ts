// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageSoundSettings, playMessageSound, previewMessageSound, setMessageSoundSettings, startMessageSounds } from './message-sounds';

const instances: FakeAudio[] = [];
const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; frequency: { setValueAtTime: ReturnType<typeof vi.fn> } }[] = [];
class FakeAudio {
  state = 'suspended'; currentTime = 0; destination = {};
  constructor() { instances.push(this); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; }
  createOscillator() { const oscillator = { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; oscillators.push(oscillator); return oscillator; }
}
let stop: (() => void) | undefined;
const allowed = () => true;
beforeEach(() => { localStorage.clear(); instances.length = 0; oscillators.length = 0; vi.stubGlobal('AudioContext', FakeAudio); vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function activate(user = 'sound-a') { stop = startMessageSounds(user); window.dispatchEvent(new Event('pointerdown')); }

describe('message chime playback and device preferences', () => {
  it('waits for a gesture without queuing old arrivals or requesting notification permission', async () => {
    stop = startMessageSounds('sound-a'); expect(instances).toHaveLength(0);
    expect(await playMessageSound('sound-a', 'before-click', allowed)).toBe(false);
    window.dispatchEvent(new Event('pointerdown')); expect(instances).toHaveLength(1);
    expect(oscillators).toHaveLength(0);
    expect(await playMessageSound('sound-a', 'before-click', allowed)).toBe(false);
    expect(await playMessageSound('sound-a', 'new', allowed)).toBe(true);
    expect(oscillators.map((node) => node.frequency.setValueAtTime.mock.calls[0][0])).toEqual([784, 1046.5]);
  });
  it('persists an account-scoped switch and volume, including zero volume', async () => {
    activate(); expect(messageSoundSettings('sound-a')).toEqual({ enabled: true, volume: .4 });
    setMessageSoundSettings('sound-a', { enabled: false, volume: .75 });
    expect(messageSoundSettings('sound-a')).toEqual({ enabled: false, volume: .75 });
    expect(messageSoundSettings('sound-b')).toEqual({ enabled: true, volume: .4 });
    expect(await playMessageSound('sound-a', 'disabled', allowed)).toBe(false);
    setMessageSoundSettings('sound-a', { enabled: true, volume: 0 });
    expect(await playMessageSound('sound-a', 'zero', allowed)).toBe(false);
  });
  it('coalesces bursts, deduplicates repeat messages and resumes after cooldown', async () => {
    activate(); expect(await playMessageSound('sound-a', 'one', allowed)).toBe(true);
    expect(await playMessageSound('sound-a', 'two', allowed)).toBe(false);
    vi.setSystemTime(12000);
    expect(await playMessageSound('sound-a', 'one', allowed)).toBe(false);
    expect(await playMessageSound('sound-a', 'three', allowed)).toBe(true); expect(oscillators).toHaveLength(4);
  });
  it('honors another tab acknowledgement and serializes eligible playback with a lock', async () => {
    activate(); const request = vi.fn(async (_name, _options, callback) => callback({ name: 'lock' }));
    vi.stubGlobal('navigator', { locks: { request } });
    localStorage.setItem('tongpin-message-sounds:recent:sound-a', JSON.stringify({ at: 9999, ids: ['elsewhere'] }));
    expect(await playMessageSound('sound-a', 'elsewhere', allowed)).toBe(false);
    expect(await playMessageSound('sound-a', 'burst', allowed)).toBe(false);
    vi.setSystemTime(12000); expect(await playMessageSound('sound-a', 'next', allowed)).toBe(true); expect(request).toHaveBeenCalledTimes(3);
  });
  it('rechecks identity and mute authority when a lock callback arrives late', async () => {
    activate(); let finish!: () => void; let valid = true;
    vi.stubGlobal('navigator', { locks: { request: vi.fn((_name, _options, callback) => new Promise((resolve) => { finish = () => resolve(callback({})); })) } });
    const pending = playMessageSound('sound-a', 'delayed', () => valid); valid = false; finish(); expect(await pending).toBe(false);
    const stopped = playMessageSound('sound-a', 'stopped', allowed); stop?.(); finish(); expect(await stopped).toBe(false); expect(oscillators).toHaveLength(0);
  });
  it('does not acquire a lock for a tab whose audio is still blocked', async () => {
    stop = startMessageSounds('sound-a'); const request = vi.fn(); vi.stubGlobal('navigator', { locks: { request } });
    expect(await playMessageSound('sound-a', 'blocked', allowed)).toBe(false); expect(request).not.toHaveBeenCalled();
  });
  it('allows explicit preview while automatic sounds are off and closes resources on stop', async () => {
    activate(); setMessageSoundSettings('sound-a', { enabled: false });
    expect(await previewMessageSound('sound-a')).toBe(true); expect(oscillators).toHaveLength(2);
    stop?.(); expect(instances[0].close).toHaveBeenCalledOnce(); expect(await playMessageSound('sound-a', 'late', allowed)).toBe(false);
    window.dispatchEvent(new Event('pointerdown')); expect(instances).toHaveLength(1);
  });
  it('handles absent audio APIs and a rejected resume without breaking delivery', async () => {
    vi.stubGlobal('AudioContext', undefined); activate(); expect(await playMessageSound('sound-a', 'absent', allowed)).toBe(false);
    vi.stubGlobal('AudioContext', FakeAudio); window.dispatchEvent(new Event('pointerdown')); instances[0].state = 'suspended'; instances[0].resume.mockRejectedValue(new Error('blocked'));
    expect(await previewMessageSound('sound-a')).toBe(false); expect(oscillators).toHaveLength(0);
  });
  it('keeps the local opt-out effective when persistence is blocked', async () => {
    activate('storage-blocked'); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    setMessageSoundSettings('storage-blocked', { enabled: false }); expect(await playMessageSound('storage-blocked', 'quiet', allowed)).toBe(false);
  });
});
