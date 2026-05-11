import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

export type IconProps = React.ComponentPropsWithoutRef<LucideIcon> & {
  /** Lucide icon component to render */
  icon: LucideIcon;
};

/**
 * Thin wrapper: default `size={16}` and `strokeWidth={1.75}` (mockup-aligned).
 * Pass `size` / `strokeWidth` to override; other props forward to the icon.
 */
export const Icon = React.forwardRef<SVGSVGElement, IconProps>(function Icon(
  { icon: Comp, size = 16, strokeWidth = 1.75, ...rest },
  ref
) {
  return <Comp ref={ref} size={size} strokeWidth={strokeWidth} {...rest} />;
});
Icon.displayName = 'Icon';
