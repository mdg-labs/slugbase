import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from './popover';
import { Input } from './input';
import { Badge } from './badge';
import { ScrollArea } from './scroll-area';
import { cn } from '@/lib/utils';

interface AutocompleteOption {
  id: string;
  name: string;
}

interface AutocompleteProps {
  value: AutocompleteOption[];
  onChange: (value: AutocompleteOption[]) => void;
  options: AutocompleteOption[];
  placeholder?: string;
  onCreateNew?: (name: string) => Promise<AutocompleteOption | null>;
  /** Surface pill chips (Obsidian bookmark modal tags) */
  pillChips?: boolean;
  className?: string;
}

export default function Autocomplete({
  value,
  onChange,
  options,
  placeholder = 'Type to search...',
  onCreateNew,
  pillChips = false,
  className = '',
}: AutocompleteProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const [open, setOpen] = useState(false);
  const [filteredOptions, setFilteredOptions] = useState<AutocompleteOption[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputValue.trim()) {
      const filtered = options.filter(
        (opt) =>
          !value.find((v) => v.id === opt.id) &&
          opt.name.toLowerCase().includes(inputValue.toLowerCase())
      );
      setFilteredOptions(filtered);
      setOpen(
        Boolean(
          filtered.length > 0 ||
            (onCreateNew !== undefined && inputValue.trim().length > 0)
        )
      );
    } else {
      setFilteredOptions([]);
      setOpen(false);
    }
  }, [inputValue, options, value, onCreateNew]);

  const handleSelect = (option: AutocompleteOption) => {
    onChange([...value, option]);
    setInputValue('');
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleRemove = (id: string) => {
    onChange(value.filter((v) => v.id !== id));
  };

  const handleCreateNew = async () => {
    if (onCreateNew && inputValue.trim()) {
      const newOption = await onCreateNew(inputValue.trim());
      if (newOption) {
        handleSelect(newOption);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && open && filteredOptions.length > 0) {
      e.preventDefault();
      handleSelect(filteredOptions[0]);
    } else if (e.key === 'Enter' && onCreateNew && inputValue.trim()) {
      e.preventDefault();
      handleCreateNew();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={cn('relative', className)}>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {value.map((item) =>
            pillChips ? (
              <span
                key={item.id}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-low py-1 pl-3 pr-1 text-sm text-foreground"
              >
                <span className="min-w-0 truncate">{item.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemove(item.id)}
                  className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-surface-high hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${t('common.remove')}: ${item.name}`}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            ) : (
              <Badge
                key={item.id}
                variant="secondary"
                className="gap-1.5 pr-1"
              >
                {item.name}
                <button
                  type="button"
                  onClick={() => handleRemove(item.id)}
                  className="rounded-full p-0.5 transition-colors hover:bg-surface-high"
                  aria-label={`${t('common.remove')}: ${item.name}`}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </Badge>
            )
          )}
        </div>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => inputValue.trim() && setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full"
          />
        </PopoverAnchor>
        <PopoverContent className="w-[var(--radix-popover-anchor-width)] p-0" align="start">
          <ScrollArea className="max-h-60">
            {filteredOptions.length === 0 && onCreateNew && inputValue.trim() ? (
              <button
                type="button"
                onClick={handleCreateNew}
                className="w-full text-left px-3 py-2 text-sm text-primary transition-colors hover:bg-surface-highest focus-visible:bg-surface-highest focus-visible:outline-none"
              >
                Create &quot;{inputValue.trim()}&quot;
              </button>
            ) : filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No options found
              </div>
            ) : (
              filteredOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleSelect(option)}
                  className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-surface-highest focus-visible:bg-surface-highest focus-visible:outline-none"
                >
                  {option.name}
                </button>
              ))
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
