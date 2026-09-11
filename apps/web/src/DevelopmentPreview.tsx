import { AppShell } from './components/AppShell';
import { EmptyState } from './components/EmptyState';

// This module is reachable only through a DEV-only dynamic import in App.tsx.
// Empty visual scaffold: it contains no accounts, conversations or messages.
export default function DevelopmentPreview() {
  return <><div className="development-banner">仅开发环境 · 界面空态预览 · 无账号与会话数据<a href="/">返回正式入口</a></div><div className="development-shell"><AppShell conversations={[]} onSelectConversation={() => undefined}><EmptyState title="让对话，自然发生" description="选择一段会话，在这里继续交流。" /></AppShell></div></>;
}
