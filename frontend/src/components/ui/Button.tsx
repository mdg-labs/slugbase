import React from 'react';
import { LucideIcon, Loader2 } from 'lucide-react';
import { Button as ShadcnButton, buttonVariants } from './button-base';
import { cn } from '@/lib/utils';

const variantMap = {
  primary: 'primary',
  secondary: 'default',
  danger: 'destructive',
  ghost: 'ghost',
  outline: 'outline',
} as const;

const sizeMap = {
  sm: 'sm',
  md: 'default',
  lg: 'lg',
} as const;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconPosition?: 'left' | 'right';
  iconClassName?: string;
  loading?: boolean;
  children?: React.ReactNode;
}

const defaultIconClass = 'h-4 w-4';

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    icon: Icon,
    iconPosition = 'left',
    iconClassName = defaultIconClass,
    loading = false,
    children,
    className = '',
    disabled,
    ...props
  },
  ref
) {
  const iconClass = iconClassName || defaultIconClass;
  const content = loading ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : (
    <>
      {Icon && iconPosition === 'left' && <Icon className={iconClass} />}
      {children && <span>{children}</span>}
      {Icon && iconPosition === 'right' && <Icon className={iconClass} />}
    </>
  );

  return (
    <ShadcnButton
      ref={ref}
      className={cn(className)}
      variant={variantMap[variant]}
      size={sizeMap[size]}
      disabled={disabled ?? loading}
      {...props}
    >
      {content}
    </ShadcnButton>
  );
});
Button.displayName = 'Button';

export default Button;

export { buttonVariants };
