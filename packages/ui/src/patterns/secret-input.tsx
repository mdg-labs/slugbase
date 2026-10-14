import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState, type ChangeEventHandler, type ReactElement, type Ref } from "react";
import { Button } from "../components/ui/button.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group.tsx";

export interface SecretInputProps {
  /** The name of the toggle while the value is hidden: it shows the value. */
  showLabel: string;
  /** The name of the toggle while the value shows: it hides the value. */
  hideLabel: string;
  value?: string;
  defaultValue?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  /** What a password manager does with the field: fill a saved password, or offer a new one. */
  autoComplete?: "current-password" | "new-password";
  name?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

/** A password field with a toggle that shows or hides what was typed. The value starts hidden. */
export function SecretInput({ showLabel, hideLabel, className, ...props }: SecretInputProps): ReactElement {
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup className={className} data-slot="secret-input">
      <InputGroupInput {...props} type={visible ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <Button
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          onClick={() => {
            setVisible((current) => !current);
          }}
          size="icon-xs"
          variant="ghost"
        >
          {visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}
