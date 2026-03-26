import { useState, useEffect } from 'react';
import { Bookmark as BookmarkIcon } from 'lucide-react';
import { fetchFavicon } from '../utils/favicon';

interface FaviconProps {
  url: string;
  className?: string;
  size?: number;
}

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

  if (loading) {
    return (
      <div className={`flex items-center justify-center rounded-md bg-surface-low ${className}`} style={{ width: `${size}px`, height: `${size}px` }}>
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
      </div>
    );
  }

  if (error || !faviconUrl) {
    return (
      <div className={`flex items-center justify-center rounded-md bg-primary/10 ${className}`} style={{ width: `${size}px`, height: `${size}px` }}>
        <BookmarkIcon className="text-primary" style={{ width: `${size}px`, height: `${size}px` }} />
      </div>
    );
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      className={`object-contain ${className}`}
      style={{ width: `${size}px`, height: `${size}px`, minWidth: `${size}px`, minHeight: `${size}px` }}
      onError={handleImageError}
      loading="lazy"
    />
  );
}
