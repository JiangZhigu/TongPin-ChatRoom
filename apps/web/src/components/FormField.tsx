import { useId, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export function FormField({ label, error, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const password = input.type === 'password';
  return <div className="form-field"><label htmlFor={id}>{label}</label><div className="input-wrap"><input {...input} id={id} type={password && visible ? 'text' : input.type} aria-invalid={!!error} aria-describedby={error || hint ? `${id}-help` : undefined} />{password && <button type="button" className="password-toggle" aria-label={`${visible ? '隐藏' : '显示'}${label}`} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>}</div>{(error || hint) && <p id={`${id}-help`} className={error ? 'field-error' : 'field-hint'}>{error || hint}</p>}</div>;
}
