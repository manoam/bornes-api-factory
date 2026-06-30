import { Request } from 'express';

/// Shape we attach to the request after a successful Keycloak validation.
/// `id` is the Keycloak `sub` claim. We deliberately don't model the full
/// JWT here — only what controllers need.
export interface AuthenticatedUser {
  id: string;
  email?: string;
  username: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  /// Realm + client roles flattened. We don't differentiate between them
  /// in business logic; the gateway permission system does the fine-grained
  /// check.
  roles: string[];
  /// Raw token, forwarded to downstream services (Stock).
  rawToken: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
