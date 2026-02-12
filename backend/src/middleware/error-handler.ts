import { Request, Response, NextFunction } from 'express';

/**
 * Error handling middleware
 * Prevents information disclosure in production
 */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // Log error details server-side
  console.error('Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  // Don't expose error details in production (M5: never send err.message or stack)
  if (process.env.NODE_ENV === 'production') {
    const status = err.statusCode || 500;
    const safeMessages: Record<number, string> = {
      400: 'Bad request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not found',
    };
    const safeMessage = status in safeMessages ? safeMessages[status] : 'Internal server error';
    return res.status(status).json({ error: safeMessage });
  }

  // Development: show more details
  return res.status(err.statusCode || 500).json({
    error: err.message || 'An error occurred',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * 404 handler
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}
