import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { queryOne } from '../db/index.js';
import { extractTokenFromRequest } from '../utils/jwt.js';

// JWT_SECRET is validated at startup via validateEnvironmentVariables()
// This will throw if not set, preventing insecure defaults
const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Please set it before starting the server.');
}

/**
 * Setup JWT strategy for Passport
 */
export function setupJWT() {
  passport.use(
    'jwt',
    new JwtStrategy(
      {
        jwtFromRequest: (req) => extractTokenFromRequest(req),
        secretOrKey: JWT_SECRET,
        algorithms: ['HS256'],
        passReqToCallback: true,
      },
      async (req: any, payload: any, done: any) => {
        try {
          if (payload?.pur === 'mfa_pending') {
            return done(null, false);
          }
          // Fetch fresh user data from database
          const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.id]);
          if (!user) {
            return done(null, false);
          }
          return done(null, user);
        } catch (error) {
          return done(error, false);
        }
      }
    )
  );
}
