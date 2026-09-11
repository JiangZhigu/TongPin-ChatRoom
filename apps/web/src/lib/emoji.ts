export type EmojiEntry = { id: string; sequence: string; name: string; english: string; keywords: string[]; group: string; subgroup: string; emojiVersion: string; variantGroup: string; tones: number[]; annotationDraft: string | null };
export type EmojiData = { unicodeVersion: string; emojiVersion: string; cldrVersion: string; license: string; groups: { id: string; label: string }[]; entries: EmojiEntry[] };
let loading: Promise<EmojiData> | undefined;
export function loadEmojiData(): Promise<EmojiData> { return loading ??= import('../data/emoji.json').then((module) => module.default).catch((error) => { loading = undefined; throw error; }); }
export function emojiKey(sequence: string): string { return Array.from(sequence, (character) => character.codePointAt(0)!.toString(16).toUpperCase()).join('-'); }
export function filterEmoji(data: EmojiData, query: string, group?: string): EmojiEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  return data.entries.filter((entry) => (!group || entry.group === group) && (!normalized || entry.sequence === query || entry.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(normalized))));
}
export function emojiVariants(data: EmojiData, entry: EmojiEntry): EmojiEntry[] { return data.entries.filter((candidate) => candidate.variantGroup === entry.variantGroup); }
export function recentEmoji(userId: string): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem('tongpin-emoji-recent:' + userId) || '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 100).slice(0, 24) : []; } catch { return []; }
}
export function rememberEmoji(userId: string, sequence: string): void {
  try { localStorage.setItem('tongpin-emoji-recent:' + userId, JSON.stringify([sequence, ...recentEmoji(userId).filter((item) => item !== sequence)].slice(0, 24))); } catch { /* Recent choices are optional; blocked storage does not prevent insertion. */ }
}
