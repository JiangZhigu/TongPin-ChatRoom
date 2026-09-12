import { MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-symbol" aria-hidden="true"><MessageCircle size={30} strokeWidth={1.4} /></span><h2>{title}</h2><p>{description}</p>{action}</div>;
}
