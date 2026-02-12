import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Upload } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { isCloud } from '../../config/mode';
import { appBasePath } from '../../config/api';

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
  // Remove HTML tags using regex (safe for extraction, not for rendering)
  // Apply repeatedly to avoid incomplete multi-character sanitization
  let text = html;
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  }
  // Remove any remaining angle brackets to avoid partial tags like "<script"
  text = text.replace(/[<>]/g, '');
  // Decode HTML entities
  text = decodeHtmlEntities(text);
  // Trim and return
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
  
  // Block dangerous protocols
  const lowerHref = trimmed.toLowerCase();
  if (lowerHref.startsWith('javascript:') || 
      lowerHref.startsWith('data:') || 
      lowerHref.startsWith('vbscript:') ||
      lowerHref.startsWith('file:') ||
      lowerHref.startsWith('about:')) {
    return null;
  }
  
  // Validate as proper URL
  try {
    const url = new URL(trimmed, window.location.origin);
    // Only allow http and https
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
 * This is safe because we only extract text and URLs, never render HTML
 */
function parseHtmlBookmarks(html: string): Array<{ title: string; url: string }> {
  const bookmarks: Array<{ title: string; url: string }> = [];
  
  // Match <a> tags with href attribute
  // This regex matches: <a ... href="..." ...>...</a>
  // We use non-greedy matching and capture href and content
  const linkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const tagContent = match[2];
    
    // Extract and validate URL
    const validatedUrl = validateAndSanitizeUrl(href);
    if (!validatedUrl) {
      continue; // Skip invalid URLs
    }
    
    // Extract text content (remove any nested HTML tags)
    const title = extractTextFromHtmlTag(tagContent);
    if (!title) {
      continue; // Skip bookmarks without titles
    }
    
    bookmarks.push({
      title,
      url: validatedUrl,
    });
  }
  
  return bookmarks;
}

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** For Cloud Free plan: current bookmark count */
  bookmarkCount?: number;
  /** For Cloud Free plan: limit (100) */
  bookmarkLimit?: number | null;
  /** Plan tier for Cloud mode */
  plan?: string | null;
}

export default function ImportModal({ isOpen, onClose, onSuccess, bookmarkCount = 0, bookmarkLimit = null, plan }: ImportModalProps) {
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
        // JSON import
        const data = JSON.parse(text);
        bookmarks = Array.isArray(data) ? data : [data];
      } else if (file.name.endsWith('.html')) {
        // HTML/Netscape bookmark format
        // Limit file size to prevent DoS attacks
        if (text.length > 10 * 1024 * 1024) { // 10MB limit
          throw new Error('HTML file is too large. Maximum size is 10MB.');
        }
        
        // Parse HTML bookmarks using regex (avoids DOMParser XSS concerns)
        // This approach extracts text and URLs without parsing HTML into DOM
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
      // Reset file input
      e.target.value = '';
    }
  }

  const atLimit = isCloud && plan === 'free' && bookmarkLimit != null && bookmarkCount >= bookmarkLimit;
  const remaining = bookmarkLimit != null ? Math.max(0, bookmarkLimit - bookmarkCount) : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('bookmarks.import')} size="md">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('bookmarks.importDescription')}
        </p>

        {atLimit && (
          <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
            <p className="text-sm text-amber-800 dark:text-amber-200">{t('plan.limitBookmarks')}</p>
            <Link
              to={`${appBasePath}/admin?tab=billing`}
              className="mt-2 inline-block text-sm font-medium text-amber-700 dark:text-amber-300 hover:underline"
            >
              {t('plan.upgradeCta')}
            </Link>
          </div>
        )}

        {!atLimit && remaining != null && remaining < 100 && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('plan.importLimitWarning', { remaining, limit: bookmarkLimit })}
          </p>
        )}

        <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center">
          <Upload className="h-12 w-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
          <label className={atLimit ? 'cursor-not-allowed' : 'cursor-pointer'}>
            <input
              type="file"
              accept=".json,.html"
              onChange={handleFileSelect}
              className="hidden"
              disabled={loading || atLimit}
            />
            <Button
              variant="primary"
              icon={Upload}
              disabled={loading || atLimit}
              onClick={() => {
                if (atLimit) return;
                const input = document.querySelector('input[type="file"]') as HTMLInputElement;
                input?.click();
              }}
            >
              {loading ? t('common.loading') : t('bookmarks.selectFile')}
            </Button>
          </label>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t('bookmarks.supportedFormats')}
          </p>
        </div>

        {error && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1" disabled={loading}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
