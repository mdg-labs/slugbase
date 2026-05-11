import React from 'react';
import {
  Tooltip as ShadcnTooltip,
  TooltipContent,
  TooltipTrigger,
} from './tooltip-base';
import { cn } from '@/lib/utils';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** Extra classes for the tooltip surface (Phase 2.7 — `tooltip-base`). */
  contentClassName?: string;
}

export default function Tooltip({
  content,
  children,
  position = 'top',
  contentClassName,
}: TooltipProps) {
  return (
    <ShadcnTooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={position} className={cn(contentClassName)}>
        {content}
      </TooltipContent>
    </ShadcnTooltip>
  );
}
