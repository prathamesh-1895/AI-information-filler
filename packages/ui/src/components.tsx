/**
 * Small shared React primitives (Tailwind classes). Accessible by default:
 * visible focus rings, real <button>/<label> elements, and status conveyed by
 * text or icons as well as colour.
 */
import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn';

const focus =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-700/60',
  secondary:
    'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
  ghost: 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:bg-red-700/60',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors motion-reduce:transition-none disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm',
        VARIANTS[variant],
        focus,
        className,
      )}
      {...props}
    />
  );
}

export type Tone = 'neutral' | 'green' | 'amber' | 'blue' | 'red' | 'violet';
const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  green: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100',
  blue: 'bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100',
  red: 'bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100',
  violet: 'bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  ...props
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function Banner({
  tone = 'blue',
  children,
  action,
  role = 'status',
  ...props
}: {
  tone?: Tone;
  children: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role={role}
      className={cn(
        'flex items-start justify-between gap-2 rounded-md px-3 py-2 text-sm',
        TONES[tone],
      )}
      {...props}
    >
      <div className="min-w-0">{children}</div>
      {action}
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 ' +
  focus;

export function TextField({
  label,
  hint,
  error,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hint || error ? `${id}-desc` : undefined}
        aria-invalid={error ? true : undefined}
        className={inputClass}
        {...props}
      />
      {(hint || error) && (
        <p
          id={`${id}-desc`}
          role={error ? 'alert' : undefined}
          className={cn(
            'text-xs',
            error ? 'text-red-700 dark:text-red-400' : 'text-slate-500 dark:text-slate-400',
          )}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <textarea
        id={id}
        aria-describedby={hint ? `${id}-desc` : undefined}
        className={cn(inputClass, 'min-h-20')}
        {...props}
      />
      {hint && (
        <p id={`${id}-desc`} className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="text-xs text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-emerald-700' : 'bg-slate-300 dark:bg-slate-700',
          focus,
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-5',
          )}
        />
        <span className="sr-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300"
    >
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-emerald-700"
      />
      {label}
    </span>
  );
}
