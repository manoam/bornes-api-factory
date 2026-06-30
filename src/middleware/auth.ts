import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { AppError } from './errorHandler';
import { AuthenticatedUser } from '../types/auth';

/**
 * Keycloak JWT validation. Same realm as Stock so users can move between
 * apps without re-authenticating — the token from Stock's frontend is
 * accepted here.
 *
 * We use jwks-rsa to fetch and cache the realm's public keys. Tokens are
 * validated against the realm issuer. Roles are flattened (realm + client)
 * into a single array for `requireRole` consumption.
 */
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'https://keycloak.orkessi.com';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'konitys';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'stock-management';

const issuer = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
const jwksUri = `${issuer}/protocol/openid-connect/certs`;

let jwks: JwksClient | null = null;
function getJwks(): JwksClient {
  if (!jwks) {
    jwks = jwksClient({
      jwksUri,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
    });
  }
  return jwks;
}

function getSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    getJwks().getSigningKey(kid, (err, key) => {
      if (err || !key) return reject(err || new Error('No signing key'));
      resolve(key.getPublicKey());
    });
  });
}

function verifyJwt(token: string): Promise<JwtPayload> {
  return new Promise((resolve, reject) => {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
      return reject(new Error('Token mal formé'));
    }
    getSigningKey(decoded.header.kid)
      .then((pubKey) => {
        jwt.verify(
          token,
          pubKey,
          { algorithms: ['RS256'], issuer },
          (err, payload) => {
            if (err || !payload || typeof payload === 'string') {
              return reject(err || new Error('Token invalide'));
            }
            resolve(payload);
          },
        );
      })
      .catch(reject);
  });
}

function extractRoles(payload: JwtPayload): string[] {
  const realm = (payload as any).realm_access?.roles || [];
  const client = (payload as any).resource_access?.[KEYCLOAK_CLIENT_ID]?.roles || [];
  return [...new Set<string>([...realm, ...client])];
}

/**
 * Calcule un nom affichable à partir des claims, dans l'ordre de préférence:
 *   1. claim `name` (Keycloak "full name", peuplé si l'admin a renseigné
 *      First + Last name)
 *   2. given_name + family_name si au moins l'un des deux est présent
 *   3. préfixe email avant @ (ex: "dev" pour dev@selfizee.fr)
 *   4. preferred_username SAUF s'il a le format laid des IdP fédérés
 *      `f:{realm-id}:{user-id}` — dans ce cas on retombe sur "Utilisateur".
 *
 * On stocke ce résultat dans createdByName/operatorName etc. côté DB. Si
 * jamais l'admin Keycloak remplit ensuite First/Last name, les NOUVEAUX
 * enregistrements seront propres ; les anciens restent tels quels (acceptable
 * pour le MVP).
 */
function computeDisplayName(payload: JwtPayload): string {
  const p = payload as any;
  if (typeof p.name === 'string' && p.name.trim()) return p.name.trim();
  const composed = [p.given_name, p.family_name]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
    .trim();
  if (composed) return composed;
  if (typeof p.email === 'string' && p.email.includes('@')) {
    return p.email.split('@')[0];
  }
  const username = typeof p.preferred_username === 'string' ? p.preferred_username : '';
  // Format Keycloak des users fédérés: `f:<uuid>:<numeric>` — illisible.
  if (username && !/^f:[\w-]+:\d+$/.test(username)) return username;
  return 'Utilisateur';
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('Authentification requise', 401);
    }
    const token = header.slice('Bearer '.length);
    const payload = await verifyJwt(token);

    const user: AuthenticatedUser = {
      id: String(payload.sub),
      email: (payload as any).email,
      username: (payload as any).preferred_username || String(payload.sub),
      firstName: (payload as any).given_name,
      lastName: (payload as any).family_name,
      fullName: computeDisplayName(payload),
      roles: extractRoles(payload),
      rawToken: token,
    };

    (req as any).user = user;
    next();
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Token invalide', 401));
  }
}

export function requireRole(...allowed: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as any).user as AuthenticatedUser | undefined;
    if (!user) return next(new AppError('Authentification requise', 401));
    if (!user.roles.some((r) => allowed.includes(r))) {
      return next(new AppError('Permission insuffisante', 403));
    }
    next();
  };
}
