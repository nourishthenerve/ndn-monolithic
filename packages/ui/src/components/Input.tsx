import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

import { interactiveClassName } from './primitive-styles.js';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /** Visible label text — every input is labelled; there is no placeholder-only variant. */
  readonly label: string;
  readonly error?: string;
}

export function Input({ label, error, className, ...rest }: InputProps): ReactNode {
  const generatedId = useId();
  const inputId = `ndn-input-${generatedId}`;
  const errorId = `ndn-input-error-${generatedId}`;
  const classes = ['ndn-input', interactiveClassName, className].filter(Boolean).join(' ');

  return (
    <div className="ndn-input-wrapper">
      <label htmlFor={inputId} className="ndn-input-label">
        {label}
      </label>
      <input
        id={inputId}
        className={classes}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="ndn-input-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
