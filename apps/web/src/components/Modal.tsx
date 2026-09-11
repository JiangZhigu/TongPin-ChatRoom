import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ open, title, children, onClose, dismissible = true }: { open: boolean; title: string; children: ReactNode; onClose: () => void; dismissible?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, [open]);
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (dismissible) onClose(); }}>
    <header className="modal-header"><h2 id={titleId}>{title}</h2>{dismissible && <button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={20} /></button>}</header><div className="modal-body">{children}</div>
  </dialog>;
}
