import * as React from 'react';
import { Label } from './label';
import { cn } from '@/lib/utils';

interface FormFieldWrapperProps {
  label: string;
  /** Inline hint after label (mockup `.field label .hint`, `styles.css` L725). */
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}

/** Mockup `.field` spacing (`styles.css` L715–727). */
export function FormFieldWrapper({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
  className,
}: FormFieldWrapperProps) {
  return (
    <div className={cn('mb-3.5 space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-[var(--danger)] ml-0.5">*</span>}
        {hint ? (
          <span className="ml-1.5 font-sans text-[11px] normal-case tracking-normal text-[var(--fg-3)]">
            {hint}
          </span>
        ) : null}
      </Label>
      {children}
      {error && (
        <p className="text-[11px] text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Mockup `.field-row` (`styles.css` L728). */
export function FormFieldRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3',
        className
      )}
    >
      {children}
    </div>
  );
}
