// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EmojiPicker } from './EmojiPicker';
import { Composer } from './Composer';
import { useState } from 'react';
const data = vi.hoisted(() => ({ entries: [
  { id: '1', sequence: '👩‍💻', name: '女程序员', english: 'woman technologist', keywords: ['女程序员','woman technologist'], group: 'people', subgroup: 'job', emojiVersion: '4', variantGroup: 'coder', tones: [], annotationDraft: null },
  { id: '2', sequence: '👩🏽‍💻', name: '女程序员：中等肤色', english: 'woman technologist medium skin tone', keywords: ['女程序员','medium skin'], group: 'people', subgroup: 'job', emojiVersion: '4', variantGroup: 'coder', tones: [3], annotationDraft: null },
  { id: '3', sequence: '🐈', name: '猫', english: 'cat', keywords: ['猫','cat'], group: 'animals', subgroup: 'animal', emojiVersion: '1', variantGroup: 'cat', tones: [], annotationDraft: null },
], unicodeVersion: '17.0.0', emojiVersion: '17.0', cldrVersion: '48.2', license: 'Unicode', groups: [{ id: 'people', label: '人物' }, { id: 'animals', label: '动物' }] }));
vi.mock('../lib/emoji', async (original) => ({ ...await original<typeof import('../lib/emoji')>(), loadEmojiData: vi.fn(async () => data) }));
beforeEach(() => { localStorage.clear(); }); afterEach(cleanup);
describe('M7-UI emoji picker', () => {
  it('searches Chinese and English, filters categories and preserves complete tone sequences', async () => { const select = vi.fn(); render(<EmojiPicker userId="one" onSelect={select} onClose={vi.fn()} />); await screen.findByRole('button', { name: '猫 / cat' }); fireEvent.change(screen.getByLabelText('搜索表情'), { target: { value: 'woman technologist' } }); expect(screen.queryByRole('button', { name: '猫 / cat' })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '选择女程序员的肤色' })); fireEvent.click(screen.getByRole('button', { name: '女程序员：中等肤色 / woman technologist medium skin tone' })); expect(select).toHaveBeenCalledWith('👩🏽‍💻'); expect(JSON.parse(localStorage.getItem('tongpin-emoji-recent:one')!)).toEqual(['👩🏽‍💻']); });
  it('keeps recent choices account scoped and supports arrow navigation and escape', async () => { localStorage.setItem('tongpin-emoji-recent:other', JSON.stringify(['🐈'])); const close = vi.fn(); render(<EmojiPicker userId="one" onSelect={vi.fn()} onClose={close} />); const first = await screen.findByRole('button', { name: '女程序员 / woman technologist' }); first.focus(); fireEvent.keyDown(first, { key: 'ArrowRight' }); expect(screen.getByRole('button', { name: '女程序员：中等肤色 / woman technologist medium skin tone' })).toHaveFocus(); fireEvent.click(screen.getByRole('button', { name: '最近使用' })); expect(screen.getByText('没有匹配的表情。')).toBeInTheDocument(); fireEvent.keyDown(screen.getByLabelText('搜索表情'), { key: 'Escape' }); expect(close).toHaveBeenCalledOnce(); });
  it('omits the picker from the composer while preserving typed Unicode text', () => { function Editor() { const [text, setText] = useState(''); return <Composer value={text} onChange={setText} onSend={vi.fn()} userId="one" />; } render(<Editor />); const input = screen.getByLabelText('消息内容'); fireEvent.change(input, { target: { value: '手动输入 👩‍💻' } }); expect(input).toHaveValue('手动输入 👩‍💻'); expect(screen.queryByRole('button', { name: '表情' })).not.toBeInTheDocument(); });
  it('does not open picker or send during active input composition', () => { const send = vi.fn(); render(<Composer value="中文" onChange={vi.fn()} onSend={send} userId="one" />); fireEvent.compositionStart(screen.getByLabelText('消息内容')); expect(screen.queryByRole('button', { name: '表情' })).not.toBeInTheDocument(); fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter', keyCode: 229 }); expect(send).not.toHaveBeenCalled(); });
});
