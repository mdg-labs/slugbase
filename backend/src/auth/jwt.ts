import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { queryOne } from '../db/index.js';
import { extractTokenFromRequest } from '../utils/jwt.js';
import { isCloud } from '../config/mode.js';

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
          // Fetch fresh user data from database
          const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.id]);
          if (!user) {
            return done(null, false);
          }
          const u = user as any;
          if (isCloud) {
            const orgMember = await queryOne(
              `SELECT role FROM org_members WHERE user_id = ? ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'member' THEN 3 ELSE 4 END LIMIT 1`,
              [payload.id]
            );
            u.org_role = orgMember ? (orgMember as any).role : null;
          }
          return done(null, user);
        } catch (error) {
          return done(error, false);
        }
      }
    )
  );
}
