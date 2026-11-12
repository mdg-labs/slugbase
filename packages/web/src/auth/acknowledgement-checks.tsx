import type { ComponentTypes } from "@slugbase/contracts";
import { Checkbox } from "@slugbase/ui";
import { useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useExtensions, type WebRegistrationAcknowledgement } from "../extensions/index.ts";

/** What a request carries for the ticked boxes. */
export type AcknowledgementEntries = ComponentTypes["schemas"]["RegistrationAcknowledgements"];

export interface AcknowledgementChecks {
  /** The required checkboxes, or nothing when no extension declares an acknowledgement. */
  readonly fields: ReactElement | null;
  /**
   * Marks every unticked box with its error. Returns undefined when all are ticked (or none is declared), else a
   * function that moves focus to the first unticked one.
   */
  readonly check: () => (() => void) | undefined;
  /** The `acknowledgements` of a request: every declared entry, or undefined when none is declared so the key is left out. */
  readonly entries: () => AcknowledgementEntries | undefined;
}

interface AcknowledgementBoxProps {
  readonly label: ReactNode;
  readonly checked: boolean;
  /** Unticked after a submit: the box is marked and the message shown. */
  readonly invalid: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly register: (element: HTMLElement | null) => void;
}

function AcknowledgementBox({ label, checked, invalid, onCheckedChange, register }: AcknowledgementBoxProps): ReactElement {
  const { t } = useTranslation();
  const errorId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid}
          checked={checked}
          className="mt-0.5"
          onCheckedChange={onCheckedChange}
          ref={register}
          required
        />
        <span>{label}</span>
      </label>
      {invalid ? (
        <p className="text-destructive-text text-sm" id={errorId} role="alert">
          {t("acknowledgement.required")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The acknowledgements the app's extensions declare, as required checkboxes for a sign-up form (doc 03 sections 1.3
 * and 1.5). The form calls `check` before it sends anything and spreads `entries` into the request.
 */
export function useAcknowledgementChecks(): AcknowledgementChecks {
  const extensions = useExtensions();
  const declared: readonly WebRegistrationAcknowledgement[] = extensions.flatMap((extension) => extension.acknowledgements ?? []);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const boxes = useRef(new Map<string, HTMLElement>());

  function toggle(id: string, checked: boolean): void {
    setTicked((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    if (checked) {
      setMissing((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }

  const fields =
    declared.length === 0 ? null : (
      <div className="flex flex-col gap-3">
        {declared.map(({ id, label }) => (
          <AcknowledgementBox
            checked={ticked.has(id)}
            invalid={missing.has(id)}
            key={id}
            label={label}
            onCheckedChange={(checked) => {
              toggle(id, checked);
            }}
            register={(element) => {
              if (element === null) {
                boxes.current.delete(id);
              } else {
                boxes.current.set(id, element);
              }
            }}
          />
        ))}
      </div>
    );

  return {
    fields,
    check() {
      const unticked = declared.filter(({ id }) => !ticked.has(id));
      setMissing(new Set(unticked.map(({ id }) => id)));
      const first = unticked[0];
      if (first === undefined) {
        return undefined;
      }
      return () => {
        boxes.current.get(first.id)?.focus();
      };
    },
    entries() {
      return declared.length === 0 ? undefined : declared.map(({ id, version }) => ({ id, version }));
    },
  };
}
