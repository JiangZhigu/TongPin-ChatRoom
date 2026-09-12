import { bus, offline } from './state';
import { sendMessage } from './core';
export class Socket {
  connected = false;
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private sync = () => { if (this.connected) this.fire('sync.available'); };
  on(name: string, listener: (...args: any[]) => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(listener); return this; }
  private fire(name: string, ...args: any[]) { for (const listener of this.listeners.get(name) || []) listener(...args); }
  connect() { if (offline) { setTimeout(() => this.fire('connect_error'), 0); return this; } this.connected = true; bus.addEventListener('sync', this.sync); setTimeout(() => this.fire('connect'), 0); return this; }
  disconnect() { this.connected = false; bus.removeEventListener('sync', this.sync); this.fire('disconnect'); return this; }
  removeAllListeners() { this.listeners.clear(); return this; }
  timeout(_milliseconds: number) { return this; }
  async emitWithAck(name: string, payload: any): Promise<any> { if (offline) throw new TypeError('Demo is offline'); if (name !== 'message.send') return { ok: true, data: {} }; try { return { ok: true, data: sendMessage(payload.conversationId, payload) }; } catch (cause) { const e = cause as { status: number; code: string; message: string }; return { ok: false, status: e.status || 400, error: { code: e.code || 'DEMO_ERROR', message: e.message } }; } }
}
export function io(..._args: any[]) { return new Socket(); }
