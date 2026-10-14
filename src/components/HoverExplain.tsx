import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, Info, Sparkles } from 'lucide-react';

export interface HoverExplainProps {
  title: string;
  explanation: string;
  tip?: string;
  badge?: string;
  children?: React.ReactNode;
  position?: 'top' | 'bottom';
  className?: string;
  inline?: boolean;
}

export const HoverExplain: React.FC<HoverExplainProps> = ({
  title,
  explanation,
  tip,
  badge = 'Guide',
  children,
  position = 'top',
  className = '',
  inline = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number; placement: 'top' | 'bottom' } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Card width: 300px max, clamped to screen width with 16px safety margin
    const tooltipWidth = Math.min(310, vw - 32);
    const estimatedHeight = 170;

    // Center tooltip on trigger horizontally, but clamp strictly within viewport edges [16px, vw - 16px - tooltipWidth]
    let x = rect.left + rect.width / 2 - tooltipWidth / 2;
    if (x < 16) x = 16;
    if (x + tooltipWidth > vw - 16) {
      x = Math.max(16, vw - 16 - tooltipWidth);
    }

    // Determine vertical placement: flip to bottom if top space is tight (< 200px)
    let placement: 'top' | 'bottom' = position;
    let y = 0;

    if (position === 'top') {
      if (rect.top > estimatedHeight + 16) {
        placement = 'top';
        y = rect.top - 8; // We will use translateY(-100%) in styling
      } else {
        placement = 'bottom';
        y = rect.bottom + 8;
      }
    } else {
      if (vh - rect.bottom > estimatedHeight + 16) {
        placement = 'bottom';
        y = rect.bottom + 8;
      } else {
        placement = 'top';
        y = rect.top - 8;
      }
    }

    // Safety clamp vertically as well
    if (placement === 'bottom' && y + estimatedHeight > vh - 16) {
      y = Math.max(16, vh - estimatedHeight - 16);
    }
    if (placement === 'top' && y < 16) {
      y = 16;
      placement = 'bottom';
    }

    setCoords({ x, y, placement });
  }, [position]);

  const handleOpen = () => {
    calculatePosition();
    setIsOpen(true);
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  useEffect(() => {
    if (!isOpen) return;

    calculatePosition();

    const handleScrollOrResize = () => {
      calculatePosition();
    };

    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);

    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [isOpen, calculatePosition]);

  return (
    <div
      ref={triggerRef}
      className={`relative ${inline ? 'inline-flex items-center' : 'inline-flex'} ${className}`}
      onMouseEnter={handleOpen}
      onMouseLeave={handleClose}
      onFocus={handleOpen}
      onBlur={handleClose}
    >
      {/* Trigger element: either custom children or subtle question-mark badge */}
      {children ? (
        <span className="inline-flex items-center gap-1 cursor-help group">
          {children}
          <HelpCircle className="w-3.5 h-3.5 text-[#84949b] group-hover:text-[#9e5b3d] transition-colors shrink-0 opacity-70 group-hover:opacity-100" />
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!isOpen) handleOpen();
            else handleClose();
          }}
          className="text-[#84949b] hover:text-[#9e5b3d] p-0.5 rounded-full transition-colors cursor-help focus:outline-none"
          aria-label={`Explain ${title}`}
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Render tooltip in document.body via Portal to prevent any parent container overflow clipping */}
      {isOpen && coords && typeof document !== 'undefined' &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              left: `${coords.x}px`,
              top: `${coords.y}px`,
              transform: coords.placement === 'top' ? 'translateY(-100%)' : 'none',
              width: `${Math.min(310, window.innerWidth - 32)}px`,
              zIndex: 99999,
              pointerEvents: 'none',
            }}
            className="p-3.5 bg-[#ffffff] text-[#1c282e] rounded-xl border border-[#d5ccc0] shadow-2xl text-left transition-all duration-150 animate-in fade-in zoom-in-95"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 border-b border-[#e5dfd5] pb-2 mb-2">
              <div className="flex items-center gap-1.5 font-bold text-xs text-[#1e3f48] truncate">
                <Info className="w-3.5 h-3.5 text-[#9e5b3d] shrink-0" />
                <span className="truncate">{title}</span>
              </div>
              <span className="text-[10px] font-semibold font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#f5f2eb] text-[#9e5b3d] border border-[#e5dfd5] shrink-0">
                {badge}
              </span>
            </div>

            {/* Explanation Body */}
            <p className="text-xs text-[#57676e] leading-relaxed mb-2 font-normal">
              {explanation}
            </p>

            {/* Practical Pro Tip */}
            {tip && (
              <div className="flex items-start gap-1.5 p-2 bg-[#faf8f5] rounded-lg border border-[#e5dfd5] text-[11px] text-[#1c282e]">
                <Sparkles className="w-3 h-3 text-[#9e5b3d] shrink-0 mt-0.5" />
                <div className="leading-tight">
                  <span className="font-semibold text-[#9e5b3d]">Quick Tip: </span>
                  <span className="text-[#57676e]">{tip}</span>
                </div>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
};
