import swaggerJsdoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine if we're running from compiled JS (production) or TS source (development)
// When running from dist/, __dirname will be dist/config, and routes will be at ../routes/
// In production, files are .js, in development they're .ts
const isProduction = __dirname.includes('dist');
const fileExtension = isProduction ? 'js' : 'ts';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'SlugBase API',
      version: '1.0.0',
      description: `API documentation for SlugBase - A bookmark management system.

**Authentication:**
- **JWT (cookie or Bearer):** Session-based, short-lived. Used when logging in via the web app.
- **Personal API Token (Bearer):** Long-lived tokens with prefix \`sb_\`. Use for scripts, CLI, or CI/CD. Create tokens at Profile > API Access. Send as \`Authorization: Bearer <token>\`.`,
      contact: {
        name: 'SlugBase',
      },
    },
    servers: [
      {
        url: process.env.BASE_URL || 'http://localhost:5000',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'token',
          description: 'JWT in httpOnly cookie (web app session)',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token (short-lived session)',
        },
        apiTokenAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Token',
          description: 'Personal API token (prefix sb_). Long-lived. Create at Profile > API Access.',
        },
      },
    },
    security: [
      {
        cookieAuth: [],
      },
      {
        bearerAuth: [],
      },
      {
        apiTokenAuth: [],
      },
    ],
  },
  apis: [
    // Use appropriate file extension based on environment
    // In development: scans .ts files from src/
    // In production: scans .js files from dist/
    join(__dirname, `../routes/*.${fileExtension}`),
    join(__dirname, `../routes/**/*.${fileExtension}`),
    join(__dirname, `../**/*.${fileExtension}`),
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
