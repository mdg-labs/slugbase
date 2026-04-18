import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import Button from '../ui/Button';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { cn } from '@/lib/utils';

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

type ImportKind = 'json' | 'html';

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
  const [kind, setKind] = useState<ImportKind>('json');
  const inputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setLoading(true);
    setError('');

    try {
      const text = await file.text();
      let bookmarks: any[] = [];

      const isJson = file.name.endsWith('.json');
      const isHtml = file.name.endsWith('.html');

      if (kind === 'json' && !isJson) {
        throw new Error(t('bookmarks.importWrongKindJson'));
      }
      if (kind === 'html' && !isHtml) {
        throw new Error(t('bookmarks.importWrongKindHtml'));
      }

      if (isJson) {
        const data = JSON.parse(text);
        if (Array.isArray(data)) {
          bookmarks = data;
        } else if (data && Array.isArray(data.bookmarks)) {
          bookmarks = data.bookmarks;
        } else {
          bookmarks = [data];
        }
      } else if (isHtml) {
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
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
    e.target.value = '';
  }

  function openPicker() {
    inputRef.current?.click();
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent wide className="flex max-h-[90vh] flex-col p-0">
        <ModalHead icon={Upload} title={t('bookmarks.import')} />

        <ModalBody>
          <p className="-mt-1 mb-4 text-[12.5px] leading-relaxed text-[var(--fg-2)]">
            {t('bookmarks.importDescription')}
          </p>

          <div className="mb-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setKind('json')}
              className={cn(
                'flex flex-col items-start gap-2 rounded-[var(--radius-sm)] border p-3 text-left transition-colors',
                kind === 'json'
                  ? 'border-[var(--accent-ring)] bg-[var(--accent-bg)] ring-1 ring-inset ring-[var(--accent-ring)]'
                  : 'border-[var(--border)] bg-[var(--bg-2)] hover:border-[var(--border-strong)]'
              )}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--bg-1)] font-mono text-[11px] font-semibold text-[var(--fg-0)] ring-1 ring-inset ring-[var(--border)]">
                SB
              </span>
              <span className="text-[12.5px] font-medium text-[var(--fg-0)]">{t('bookmarks.importSourceJson')}</span>
              <span className="font-mono text-[10px] text-[var(--fg-3)]">.json</span>
            </button>
            <button
              type="button"
              onClick={() => setKind('html')}
              className={cn(
                'flex flex-col items-start gap-2 rounded-[var(--radius-sm)] border p-3 text-left transition-colors',
                kind === 'html'
                  ? 'border-[var(--accent-ring)] bg-[var(--accent-bg)] ring-1 ring-inset ring-[var(--accent-ring)]'
                  : 'border-[var(--border)] bg-[var(--bg-2)] hover:border-[var(--border-strong)]'
              )}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--bg-1)] font-mono text-[11px] font-semibold text-[var(--fg-0)] ring-1 ring-inset ring-[var(--border)]">
                HT
              </span>
              <span className="text-[12.5px] font-medium text-[var(--fg-0)]">{t('bookmarks.importSourceHtml')}</span>
              <span className="font-mono text-[10px] text-[var(--fg-3)]">.html</span>
            </button>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept=".json,.html"
            onChange={handleFileSelect}
            className="hidden"
            disabled={loading}
          />

          <button
            type="button"
            onClick={openPicker}
            disabled={loading}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-strong)] bg-[var(--bg-2)] px-4 py-8 text-center transition-colors hover:border-[var(--accent-ring)] hover:bg-[var(--bg-1)] disabled:opacity-50"
          >
            <Upload className="h-5 w-5 text-[var(--fg-3)]" strokeWidth={1.75} />
            <span className="text-[12.5px] text-[var(--fg-2)]">{t('bookmarks.importDropHint')}</span>
            <span className="font-mono text-[11px] text-[var(--fg-3)]">{t('bookmarks.importOrBrowse')}</span>
          </button>

          {error && (
            <div className="mt-3 rounded-[var(--radius-sm)] border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2">
              <p className="text-[12.5px] text-[var(--danger)]">{error}</p>
            </div>
          )}
        </ModalBody>

        <ModalFoot className="justify-between sm:justify-end">
          <Button variant="ghost" type="button" size="md" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}
