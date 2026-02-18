import React from 'react';
import { LucideIcon, Loader2 } from 'lucide-react';
import { Button as ShadcnButton, buttonVariants } from './button-base';
import { cn } from '@/lib/utils';

const variantMap = {
  primary: 'default',
  secondary: 'secondary',
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
  loading?: boolean;
  children?: React.ReactNode;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  loading = false,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const content = loading ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : (
    <>
      {Icon && iconPosition === 'left' && <Icon className="h-4 w-4" />}
      {children && <span>{children}</span>}
      {Icon && iconPosition === 'right' && <Icon className="h-4 w-4" />}
    </>
  );

  return (
    <ShadcnButton
      className={cn(className)}
      variant={variantMap[variant]}
      size={sizeMap[size]}
      disabled={disabled ?? loading}
      {...props}
    >
      {content}
    </ShadcnButton>
  );
}

export { buttonVariants };
