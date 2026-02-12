import React from 'react';
import { LucideIcon } from 'lucide-react';

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
  disabled,
  ...props
}: ButtonProps) {
  const baseClasses = 'inline-flex items-center justify-center font-medium rounded-lg transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
  
  const variantClasses = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 focus-visible:ring-blue-500 shadow-sm hover:shadow',
    secondary: 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-300 dark:hover:bg-gray-600 focus-visible:ring-gray-500',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 shadow-sm hover:shadow',
    ghost: 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-gray-500',
  };

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-[13px] gap-1.5',
    md: 'px-4 py-2.5 text-[13px] gap-2',
    lg: 'px-6 py-3 text-[13px] gap-2.5',
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled}
      {...props}
    >
      {Icon && iconPosition === 'left' && <Icon className="h-4 w-4" />}
      {children && <span>{children}</span>}
      {Icon && iconPosition === 'right' && <Icon className="h-4 w-4" />}
    </button>
  );
}
