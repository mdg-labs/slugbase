import React, { useState, useRef, useEffect, useId } from 'react';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export default function Tooltip({ content, children, position = 'top' }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const tooltipId = `tooltip-${generatedId.replace(/:/g, '')}`;

  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      // Use requestAnimationFrame to ensure tooltip is rendered before calculating position
      requestAnimationFrame(() => {
        if (!triggerRef.current || !tooltipRef.current) return;
        
        const triggerRect = triggerRef.current.getBoundingClientRect();
        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        // Tooltip uses position: fixed, so use viewport coordinates from getBoundingClientRect
        let top = 0;
        let left = 0;

        switch (position) {
          case 'top':
            top = triggerRect.top - tooltipRect.height - 8;
            left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
            break;
          case 'bottom':
            top = triggerRect.bottom + 8;
            left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
            break;
          case 'left':
            top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
            left = triggerRect.left - tooltipRect.width - 8;
            break;
          case 'right':
            top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
            left = triggerRect.right + 8;
            break;
        }

        // Keep tooltip within viewport
        const padding = 8;
        if (top < padding) top = padding;
        if (left < padding) left = padding;
        if (left + tooltipRect.width > window.innerWidth - padding) {
          left = window.innerWidth - tooltipRect.width - padding;
        }
        if (top + tooltipRect.height > window.innerHeight - padding) {
          top = window.innerHeight - tooltipRect.height - padding;
        }

        setTooltipPosition({ top, left });
      });
    }
  }, [isVisible, position]);

  const handleShow = () => setIsVisible(true);
  const handleHide = () => setIsVisible(false);

  const clonedChild = React.cloneElement(children, {
    onMouseEnter: handleShow,
    onMouseLeave: handleHide,
    onFocus: handleShow,
    onBlur: handleHide,
    ...(isVisible && { 'aria-describedby': tooltipId }),
  });

  return (
    <>
      <span ref={triggerRef as any} className="inline-block">
        {clonedChild}
      </span>
      {isVisible && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="fixed z-50 px-3 py-2 text-sm bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg pointer-events-none"
          style={{
            top: `${tooltipPosition.top}px`,
            left: `${tooltipPosition.left}px`,
          }}
        >
          {content}
          <div
            className={`absolute w-2 h-2 bg-gray-900 dark:bg-gray-700 transform rotate-45 ${
              position === 'top'
                ? 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2'
                : position === 'bottom'
                ? 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2'
                : position === 'left'
                ? 'right-0 top-1/2 -translate-y-1/2 translate-x-1/2'
                : 'left-0 top-1/2 -translate-y-1/2 -translate-x-1/2'
            }`}
          />
        </div>
      )}
    </>
  );
}
