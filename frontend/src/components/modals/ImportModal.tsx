import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Separator } from '../ui/separator';
import Button from '../ui/Button';
import api from '../../api/client';
import { useToast } from '../ui/Toast';

/**
 * Decode HTML entities safely (only common ones, no script execution)
 */
function decodeHtmlEntities(text: string): string {
  const entityMap: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&#x2F;': '/',
  };

  return text.replace(/&[#\w]+;/g, (entity) => {
    return entityMap[entity] || entity;
  });
}

/**
 * Extract text content from HTML tag safely (without parsing HTML)
 * Removes HTML tags and decodes entities
 */
function extractTextFromHtmlTag(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }
  let text = html;
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  }
  text = text.replace(/[<>]/g, '');
  text = decodeHtmlEntities(text);
  return text.trim();
}

/**
 * Validate and sanitize URL
 */
function validateAndSanitizeUrl(href: string): string | null {
  if (!href || typeof href !== 'string') {
    return null;
  }

  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  const lowerHref = trimmed.toLowerCase();
  if (lowerHref.startsWith('javascript:') ||
      lowerHref.startsWith('data:') ||
      lowerHref.startsWith('vbscript:') ||
      lowerHref.startsWith('file:') ||
      lowerHref.startsWith('about:')) {
    return null;
  }

  try {
    const url = new URL(trimmed, window.location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Parse HTML bookmark file using regex (avoids DOMParser XSS concerns)
 */
function parseHtmlBookmarks(html: string): Array<{ title: string; url: string }> {
  const bookmarks: Array<{ title: string; url: string }> = [];
  const linkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const tagContent = match[2];

    const validatedUrl = validateAndSanitizeUrl(href);
    if (!validatedUrl) continue;

    const title = extractTextFromHtmlTag(tagContent);
    if (!title) continue;

    bookmarks.push({ title, url: validatedUrl });
  }

  return bookmarks;
}

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ImportModal({ isOpen, onClose, onSuccess }: ImportModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError('');

    try {
      const text = await file.text();
      let bookmarks: any[] = [];

      if (file.name.endsWith('.json')) {
        const data = JSON.parse(text);
        if (Array.isArray(data)) {
          bookmarks = data;
        } else if (data && Array.isArray(data.bookmarks)) {
          bookmarks = data.bookmarks;
        } else {
          bookmarks = [data];
        }
      } else if (file.name.endsWith('.html')) {
        if (text.length > 10 * 1024 * 1024) {
          throw new Error('HTML file is too large. Maximum size is 10MB.');
        }
        bookmarks = parseHtmlBookmarks(text);
      } else {
        throw new Error('Unsupported file format. Please use JSON or HTML.');
      }

      if (bookmarks.length === 0) {
        throw new Error('No bookmarks found in file.');
      }

      const response = await api.post('/bookmarks/import', { bookmarks });
      showToast(
        t('bookmarks.importSuccess', {
          success: response.data.success,
          failed: response.data.failed
        }),
        response.data.failed > 0 ? 'warning' : 'success'
      );
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || t('common.error'));
      showToast(err.response?.data?.error || err.message || t('common.error'), 'error');
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('bookmarks.import')}</DialogTitle>
        </DialogHeader>
        <Separator />

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('bookmarks.importDescription')}
          </p>

          <div className="border-2 border-dashed border-ghost rounded-xl bg-surface-low p-6 text-center">
            <Upload className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".json,.html"
                onChange={handleFileSelect}
                className="hidden"
                disabled={loading}
              />
              <Button
                variant="primary"
                icon={Upload}
                disabled={loading}
                loading={loading}
                className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                onClick={() => {
                  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
                  input?.click();
                }}
              >
                {loading ? t('common.loading') : t('bookmarks.selectFile')}
              </Button>
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('bookmarks.supportedFormats')}
            </p>
          </div>

          {error && (
            <div className="px-4 py-3 rounded-lg border bg-destructive/10 border-destructive/20">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>

        <Separator />
        <DialogFooter className="flex-row justify-end">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
