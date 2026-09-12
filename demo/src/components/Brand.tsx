import { MessageSquareText } from 'lucide-react';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><span className="brand-mark" aria-hidden="true"><MessageSquareText size={25} strokeWidth={2.3} /></span>{!compact && <span>同频<span className="brand-dot">.</span></span>}</span>;
}
