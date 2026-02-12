import React, { useState, useRef, useEffect } from 'react';
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
  className?: string;
}

export default function Autocomplete({
  value,
  onChange,
  options,
  placeholder = 'Type to search...',
  onCreateNew,
  className = '',
}: AutocompleteProps) {
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
          {value.map((item) => (
            <Badge
              key={item.id}
              variant="secondary"
              className="pr-1 gap-1.5"
            >
              {item.name}
              <button
                type="button"
                onClick={() => handleRemove(item.id)}
                className="rounded-full hover:bg-secondary/80 p-0.5 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Badge>
          ))}
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
                className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-accent hover:text-accent-foreground"
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
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
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
