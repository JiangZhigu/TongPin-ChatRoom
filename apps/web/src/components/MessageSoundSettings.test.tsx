// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MessageSoundSettings } from './MessageSoundSettings';
import { messageSoundSettings, previewMessageSound } from '../lib/message-sounds';
vi.mock('../lib/message-sounds', async (original) => ({ ...await original<typeof import('../lib/message-sounds')>(), messageSoundsSupported: () => true, previewMessageSound: vi.fn(async () => true) }));
beforeEach(() => { localStorage.clear(); vi.mocked(previewMessageSound).mockReset().mockResolvedValue(true); });
afterEach(cleanup);
describe('message sound controls', () => {
  it('persists mute and volume for the current account and previews only on click', async () => {
    const view = render(<MessageSoundSettings userId="settings-a" />);
    expect(screen.getByRole('checkbox', { name: '播放消息提示音' })).toBeChecked();
    fireEvent.change(screen.getByRole('slider', { name: '提示音音量' }), { target: { value: '65' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '播放消息提示音' }));
    expect(messageSoundSettings('settings-a')).toEqual({ enabled: false, volume: .65 });
    expect(screen.getByRole('slider')).toBeDisabled(); expect(previewMessageSound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '试听提示音' })); await screen.findByText('提示音已播放。');
    expect(previewMessageSound).toHaveBeenCalledExactlyOnceWith('settings-a');
    view.unmount(); render(<MessageSoundSettings userId="settings-a" />); expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('slider')).toHaveValue('65');
  });
  it('ignores a late preview result after the visible identity changes', async () => {
    let finish!: (value: boolean) => void; vi.mocked(previewMessageSound).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<MessageSoundSettings userId="settings-a" />); fireEvent.click(screen.getByRole('button', { name: '试听提示音' }));
    view.rerender(<MessageSoundSettings userId="settings-b" />); await act(async () => finish(true)); expect(screen.queryByText('提示音已播放。')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeChecked(); expect(screen.getByRole('slider')).toHaveValue('40');
  });
});
