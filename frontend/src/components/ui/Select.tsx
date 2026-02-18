import FolderIcon from '../FolderIcon';
import {
  Select as ShadcnSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select-base';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: string | null;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export default function Select({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  className = '',
}: SelectProps) {
  return (
    <ShadcnSelect value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No options</div>
        ) : (
          options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              <span className="flex items-center gap-2">
                {option.icon != null && (
                  <FolderIcon iconName={option.icon} size={16} className="text-muted-foreground" />
                )}
                {option.label}
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </ShadcnSelect>
  );
}
