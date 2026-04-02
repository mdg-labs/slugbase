# Contributing to SlugBase

Thank you for your interest in contributing to SlugBase! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for all contributors.

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue with:

1. **Clear title and description** - Describe what happened vs. what you expected
2. **Steps to reproduce** - Provide detailed steps to reproduce the issue
3. **Environment information**:
   - OS and version
   - Node.js version
   - Database type (SQLite/PostgreSQL)
   - Browser (if frontend issue)
4. **Screenshots/logs** - If applicable, include screenshots or error logs
5. **Possible solution** - If you have ideas on how to fix it, share them!

### Suggesting Features

Feature requests are welcome! Please open an issue with:

1. **Clear description** - What feature would you like to see?
2. **Use case** - Why is this feature useful?
3. **Possible implementation** - If you have ideas on how to implement it, share them!

### Pull Requests

We welcome pull requests! Here's how to contribute:

#### 1. Fork and Clone

```bash
git clone https://github.com/mdg-labs/slugbase.git
cd slugbase
```

#### 2. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

#### 3. Development Setup

```bash
# Install dependencies
npm install

# Start development servers
npm run dev
```

#### 4. Make Your Changes

- Follow the existing code style
- Write clear, self-documenting code
- Add comments for complex logic
- Update documentation if needed
- Add tests if applicable

#### 5. Code Style Guidelines

**TypeScript/JavaScript:**
- Use TypeScript for type safety
- Follow existing naming conventions
- Use meaningful variable and function names
- Keep functions focused and small
- Use async/await for asynchronous code

**React Components:**
- Use functional components with hooks
- Keep components focused and reusable
- Extract complex logic into custom hooks
- Use TypeScript interfaces for props

**Backend:**
- Follow RESTful API conventions
- Use parameterized queries (never string concatenation)
- Add proper error handling
- Update `backend/openapi/openapi.selfhosted.yaml` when you add or change documented HTTP endpoints

**Styling:**
- Use Tailwind CSS utility classes
- Follow the style guide in `PRD/STYLEGUIDE.md`
- Ensure dark mode support
- Maintain responsive design

**Internationalization:**
- Always add translations to `en.json` first
- Add translations to `de.json` and `fr.json`
- Use translation keys, never hardcoded strings
- Keep `en.json` as the single source of truth

#### 6. Commit Your Changes

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Format: <type>(<scope>): <description>

# Examples:
git commit -m "feat(bookmarks): add bulk delete functionality"
git commit -m "fix(auth): correct OIDC redirect handling"
git commit -m "docs(readme): update installation instructions"
git commit -m "refactor(api): simplify error handling"
```

**Commit Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

#### 7. Test Your Changes

```bash
# Build both frontend and backend
npm run build

# Test the application manually
# - Start the dev servers
# - Test your changes thoroughly
# - Check for console errors
# - Verify dark mode works
# - Test on different screen sizes
```

#### 8. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then open a pull request on GitHub with:

1. **Clear title** - Use conventional commit format
2. **Description** - Explain what changes you made and why
3. **Related issues** - Link to any related issues (e.g., "Fixes #123")
4. **Screenshots** - If UI changes, include before/after screenshots
5. **Testing notes** - Describe how you tested your changes

## Development Guidelines

### Project Structure

- **Frontend**: `frontend/src/` - React TypeScript application
- **Backend**: `backend/src/` - Express TypeScript server
- **Documentation**: `docs/` - User-facing documentation
- **Migrations**: `backend/src/db/migrations/` - Database migrations

### Adding New Features

1. **Frontend Features**:
   - Create components in appropriate directories
   - Add translations to all locale files
   - Follow the style guide
   - Ensure dark mode support
   - Test responsive design

2. **Backend Features**:
   - Add routes in `backend/src/routes/`
   - Update `backend/openapi/openapi.selfhosted.yaml` for integrator-facing endpoints
   - Handle errors properly
   - Use parameterized queries
   - Add validation

3. **Database Changes**:
   - Create migration in `backend/src/db/migrations/`
   - Follow naming: `NNN_description.ts`
   - Export `migrationId`, `migrationName`, `up()`, and optionally `down()`
   - Register in `backend/src/db/migrations/index.ts`
   - Support both SQLite and PostgreSQL

### Adding Translations

1. Add new keys to `frontend/src/locales/en.json`
2. Add translations to `frontend/src/locales/de.json`
3. Add translations to `frontend/src/locales/fr.json`
4. Keep `en.json` as the single source of truth

### Database Migrations

When creating migrations:

1. **Naming**: `NNN_description.ts` (e.g., `006_add_user_preferences.ts`)
2. **Structure**:
   ```typescript
   export const migrationId = '006';
   export const migrationName = 'add_user_preferences';
   
   export async function up() {
     // Migration logic
   }
   
   export async function down() {
     // Rollback logic (optional)
   }
   ```
3. **Database Support**: Ensure migrations work with both SQLite and PostgreSQL
4. **Registration**: Import and register in `backend/src/db/migrations/index.ts`

### Testing

While we don't have automated tests yet, please:

- Test your changes manually
- Test in both light and dark mode
- Test on different screen sizes
- Test with both SQLite and PostgreSQL (if database changes)
- Verify error handling
- Check browser console for errors

## Getting Help

- **Issues**: Open an issue for bugs or feature requests
- **Discussions**: Use GitHub Discussions for questions
- **Documentation**: Check the `docs/` directory

## Recognition

Contributors will be recognized in:
- The project README (if significant contributions)
- Release notes (for major contributions)

Thank you for contributing to SlugBase! 🎉
