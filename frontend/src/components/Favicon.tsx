import { useState, useEffect } from 'react';
import { Bookmark as BookmarkIcon } from 'lucide-react';
import { fetchFavicon } from '../utils/favicon';
import { cn } from '@/lib/utils';

interface FaviconProps {
  url: string;
  className?: string;
  size?: number;
}

/**
 * Mockup `.f-ico`-style tile: rounded square, mixed accent + `--bg-2` fill; image sits inside.
 */
export default function Favicon({ url, className = '', size = 20 }: FaviconProps) {
  const [faviconUrl, setFaviconUrl] = useState<string>('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (url) {
      setLoading(true);
      setError(false);
      setFaviconUrl('');
      fetchFavicon(url)
        .then((favicon) => {
          if (favicon) {
            setFaviconUrl(favicon);
            setError(false);
          } else {
            setError(true);
            setFaviconUrl('');
          }
          setLoading(false);
        })
        .catch(() => {
          setError(true);
          setFaviconUrl('');
          setLoading(false);
        });
    } else {
      setError(true);
      setFaviconUrl('');
      setLoading(false);
    }
  }, [url]);

  const handleImageError = () => {
    setError(true);
    setFaviconUrl('');
    setLoading(false);
  };

  const tileClass = cn(
    'f-ico inline-grid shrink-0 place-items-center overflow-hidden rounded-[22%] border border-[var(--border-soft)] bg-[color-mix(in_srgb,var(--accent)_14%,var(--bg-2))]',
    className
  );
  const dim = { width: size, height: size, minWidth: size, minHeight: size };

  if (loading) {
    return (
      <div className={tileClass} style={dim}>
        <div
          className="size-[55%] animate-pulse rounded-full bg-[var(--bg-3)]"
          aria-hidden
        />
      </div>
    );
  }

  if (error || !faviconUrl) {
    return (
      <div className={tileClass} style={dim}>
        <BookmarkIcon
          className="text-[var(--accent)]"
          style={{ width: `${Math.round(size * 0.55)}px`, height: `${Math.round(size * 0.55)}px` }}
          strokeWidth={1.75}
          aria-hidden
        />
      </div>
    );
  }

  return (
    <div className={tileClass} style={dim}>
      <img
        src={faviconUrl}
        alt=""
        className="size-[85%] object-contain"
        onError={handleImageError}
        loading="lazy"
      />
    </div>
  );
}
