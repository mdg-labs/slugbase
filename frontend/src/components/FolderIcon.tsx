import React from 'react';
import * as LucideIcons from 'lucide-react';
import { Folder as DefaultFolderIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FolderIconProps {
  iconName?: string | null;
  className?: string;
  size?: number;
  /** Optional CSS color for `.f-ico` mixing + icon stroke (e.g. folder accent from API later). */
  accentColor?: string | null;
}

// Get all available icon names from lucide-react
// Filter out non-icon exports and get all icon component names
// Lucide icons are React forward ref components (objects with $$typeof and render method)
function getAllIconNames(): string[] {
  const iconNames: string[] = [];
  const excludeNames = new Set([
    'createLucideIcon',
    'Icon',
    'IconNode',
    'IconProps',
    'LucideProps',
    'default',
    // Exclude non-icon exports
    'defaultProps',
    'forwardRef',
    'memo',
    'lazy',
    'Suspense',
    'Fragment',
    'StrictMode',
  ]);

  for (const name in LucideIcons) {
    // Skip excluded names
    if (excludeNames.has(name)) continue;
    
    // Skip names starting with lowercase (likely not icon components)
    if (name[0] && name[0] === name[0].toLowerCase()) continue;
    
    // Skip names ending with 'Icon' (these are typically type exports)
    if (name.endsWith('Icon')) continue;
    
    const component = (LucideIcons as any)[name];
    
    // Check if it's a valid React component
    // Lucide icons can be either:
    // 1. Function components (typeof === 'function')
    // 2. Forward ref components (object with $$typeof and render method)
    const isFunctionComponent = typeof component === 'function';
    const isForwardRefComponent = component && 
      typeof component === 'object' && 
      (component.$$typeof || component.render);
    
    if (isFunctionComponent || isForwardRefComponent) {
      iconNames.push(name);
    }
  }

  return iconNames.sort();
}

// Cache the icon names
let cachedIconNames: string[] | null = null;

export function getAllIcons(): string[] {
  if (!cachedIconNames) {
    cachedIconNames = getAllIconNames();
  }
  return cachedIconNames;
}

// Popular/recommended icons for quick access
const popularIcons = [
  'Folder',
  'FolderOpen',
  'Archive',
  'Briefcase',
  'FileText',
  'Image',
  'Video',
  'Music',
  'Code',
  'Database',
  'Book',
  'GraduationCap',
  'Heart',
  'Star',
  'Home',
  'Calendar',
  'Mail',
  'Settings',
  'Users',
  'Package',
  'Wrench',
  'Tool',
  'Hammer',
  'Screwdriver',
  'FolderPlus',
  'FolderMinus',
  'FolderCheck',
  'FolderX',
  'File',
  'FileCode',
  'FileImage',
  'FileVideo',
  'FileAudio',
  'FileSpreadsheet',
  'FileType',
  'FolderKanban',
  'FolderTree',
  'FolderGit',
  'FolderGit2',
  'FolderSearch',
  'FolderSymlink',
  'FolderUp',
  'FolderDown',
  'FolderInput',
  'FolderOutput',
  'FolderRoot',
  'FolderLock',
  'FolderUnlock',
  'FolderHeart',
  'FolderKey',
  'FolderPen',
  'FolderArchive',
  'FolderOpenDot',
  'FolderDot',
  'FolderSync',
  'FolderClock',
  'FolderCog',
  'FolderPlus2',
  'FolderMinus2',
  'FolderCheck2',
  'FolderX2',
  'FolderQuestion',
  'FolderWarning',
  'FolderAlert',
  'FolderBan',
  'FolderOff',
  'FolderOn',
  'FolderUp2',
  'FolderDown2',
  'FolderInput2',
  'FolderOutput2',
  'FolderRoot2',
  'FolderLock2',
  'FolderUnlock2',
  'FolderHeart2',
  'FolderKey2',
  'FolderPen2',
  'FolderArchive2',
  'FolderOpenDot2',
  'FolderDot2',
  'FolderSync2',
  'FolderClock2',
  'FolderCog2',
  'FolderPlus2',
  'FolderMinus2',
  'FolderCheck2',
  'FolderX2',
  'FolderQuestion2',
  'FolderWarning2',
  'FolderAlert2',
  'FolderBan2',
  'FolderOff2',
  'FolderOn2',
];

export default function FolderIcon({
  iconName,
  className = '',
  size = 20,
  accentColor,
}: FolderIconProps) {
  const iconClass = className || 'text-primary';
  const showTile = size >= 16;
  const iconPx = Math.max(10, Math.round(size * 0.52));
  const bgStyle: React.CSSProperties = accentColor
    ? { background: `color-mix(in srgb, ${accentColor} 32%, var(--bg-2))` }
    : { background: 'color-mix(in srgb, var(--accent) 32%, var(--bg-2))' };

  const iconStyle = (tile: boolean): React.CSSProperties => ({
    width: tile ? iconPx : size,
    height: tile ? iconPx : size,
    ...(accentColor ? { color: accentColor } : {}),
  });

  const wrapTile = (node: React.ReactNode) => (
    <span
      className={cn(
        'f-ico inline-grid shrink-0 place-items-center rounded-[22%] border border-[var(--border-soft)]',
        iconClass
      )}
      style={{ width: size, height: size, ...bgStyle }}
    >
      {node}
    </span>
  );

  if (!iconName) {
    const node = (
      <DefaultFolderIcon
        className={showTile ? undefined : iconClass}
        style={iconStyle(showTile)}
      />
    );
    return showTile ? wrapTile(node) : node;
  }

  // Try to get the icon from lucide-react (exact match first)
  let IconComponent = (LucideIcons as any)[iconName] as React.ComponentType<{ className?: string; style?: React.CSSProperties }>;

  // If exact match not found, try case-insensitive lookup
  if (!IconComponent) {
    const iconNameLower = iconName.toLowerCase();
    for (const key in LucideIcons) {
      if (key.toLowerCase() === iconNameLower) {
        const candidate = (LucideIcons as any)[key];
        // Check if it's a valid component (function or forward ref object)
        const isValid = typeof candidate === 'function' || 
          (candidate && typeof candidate === 'object' && (candidate.$$typeof || candidate.render));
        if (isValid) {
          IconComponent = candidate as React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
          break;
        }
      }
    }
  }

  // Verify IconComponent is valid before rendering
  const isValidComponent = IconComponent && 
    (typeof IconComponent === 'function' || 
     (typeof IconComponent === 'object' && IconComponent !== null && ((IconComponent as any).$$typeof || (IconComponent as any).render)));

  if (isValidComponent) {
    const node = (
      <IconComponent
        className={showTile ? undefined : iconClass}
        style={iconStyle(showTile)}
      />
    );
    return showTile ? wrapTile(node) : node;
  }

  const fallback = (
    <DefaultFolderIcon
      className={showTile ? undefined : iconClass}
      style={iconStyle(showTile)}
    />
  );
  return showTile ? wrapTile(fallback) : fallback;
}

export { popularIcons };
