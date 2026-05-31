import { useTranslate } from "@tolgee/react";
import { useRef } from "react";

interface TotpInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Segmented 6-digit TOTP input with auto-advance, backspace navigation,
 * and paste support. Renders in IBM Plex Mono per the design system.
 */
export function TotpInput({ value, onChange, disabled = false }: TotpInputProps) {
  const { t } = useTranslate();
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const handleChange = (index: number, char: string): void => {
    const digit = char.replace(/\D/g, "").slice(-1);
    const chars = value.split("");
    while (chars.length < 6) chars.push("");
    chars[index] = digit;
    onChange(chars.join("").slice(0, 6));
    if (digit && index < 5) {
      refs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (
    e: React.ClipboardEvent<HTMLInputElement>,
  ): void => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted) {
      onChange(pasted.padEnd(6, " ").slice(0, 6).replace(/ /g, ""));
      const nextIndex = Math.min(pasted.length, 5);
      refs.current[nextIndex]?.focus();
    }
  };

  return (
    <div
      className="flex gap-sp-2"
      role="group"
      aria-label={t("mfa.challenge.code_input_aria")}
    >
      {([0, 1, 2, 3, 4, 5] as const).map((i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={value[i] ?? ""}
          onChange={(e) => {
            handleChange(i, e.target.value);
          }}
          onKeyDown={(e) => {
            handleKeyDown(i, e);
          }}
          onPaste={handlePaste}
          disabled={disabled}
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={t("mfa.challenge.digit_aria", { n: String(i + 1) })}
          className="h-12 w-10 rounded-md border border-[color:var(--border)] bg-raised text-center text-fg focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50 data-[filled=true]:border-[color:var(--accent)]"
          data-filled={Boolean(value[i]) || undefined}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-h3)",
            lineHeight: "var(--lh-h3)",
          }}
        />
      ))}
    </div>
  );
}
