import React from 'react';
import { LucideIcon } from 'lucide-react';
import { Button as ShadcnButton, buttonVariants } from './button-base';
import { cn } from '@/lib/utils';

const variantMap = {
  primary: 'default',
  secondary: 'secondary',
  danger: 'destructive',
  ghost: 'ghost',
} as const;

const sizeMap = {
  sm: 'sm',
  md: 'default',
  lg: 'lg',
} as const;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconPosition?: 'left' | 'right';
  children?: React.ReactNode;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  children,
  className = '',
  ...props
}: ButtonProps) {
  const content = (
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
      {...props}
    >
      {content}
    </ShadcnButton>
  );
}

export { buttonVariants };
