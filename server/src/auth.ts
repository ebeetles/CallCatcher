import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { authMode, config } from "./config.ts";
import { tenants, users } from "./db.ts";
import type { TenantRecord, UserRecord } from "./types.ts";

/**
 * Authentication for the multi-tenant API.
 *
 * Three modes (config.authMode):
 *  - "supabase": requests carry a Supabase access JWT. We verify it (asymmetric
 *    keys via the project's JWKS endpoint, or the legacy HS256 secret) and map
 *    the `sub` claim to a local users row, bootstrapping user + tenant on first
 *    sight. DASHBOARD_TOKEN additionally authenticates the ops context.
 *  - "token": pre-SaaS single-token deployments — DASHBOARD_TOKEN = ops context.
 *  - "open": zero-config local dev — every request runs as the dev tenant.
 */

export interface AuthContext {
  user: UserRecord;
  tenant: TenantRecord;
  /** Platform admins additionally see legacy NULL-tenant rows and /admin APIs. */
  platformAdmin: boolean;
}

export interface SupabaseClaims {
  sub: string;
  email: string;
  agencyName?: string;
}

const TRIAL_DAYS = 14;

// jose's remote JWK set caches keys and refetches on unknown-kid, so a lazy
// singleton is all the caching we need.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function claimsFrom(payload: JWTPayload): SupabaseClaims | undefined {
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!sub || !email) return undefined;
  const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
  const agencyName = typeof meta.agency_name === "string" && meta.agency_name.trim() ? meta.agency_name.trim() : undefined;
  return { sub, email, agencyName };
}

/** Verify a Supabase access token; returns its identity claims or undefined. */
export async function verifySupabaseJwt(token: string): Promise<SupabaseClaims | undefined> {
  const issuer = config.supabaseUrl ? `${config.supabaseUrl}/auth/v1` : undefined;

  // Legacy HS256 secret (older projects; also how tests mint tokens).
  if (config.supabaseJwtSecret) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(config.supabaseJwtSecret), {
        algorithms: ["HS256"],
        audience: "authenticated",
        ...(issuer ? { issuer } : {}),
      });
      return claimsFrom(payload);
    } catch {
      // fall through to JWKS
    }
  }

  // Current projects sign with asymmetric keys published at the JWKS endpoint.
  if (config.supabaseUrl) {
    try {
      jwks ??= createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`));
      const { payload } = await jwtVerify(token, jwks, { audience: "authenticated", issuer });
      return claimsFrom(payload);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Map verified claims to a local user + tenant, creating both on first sight.
 * ADMIN_EMAILS users become platform admins and permanently adopt legacy
 * (NULL-tenant) businesses into their tenant.
 */
export function ensureUser(claims: SupabaseClaims): AuthContext {
  let user = users.get(claims.sub);
  if (!user) {
    const isAdmin = config.adminEmails.includes(claims.email.toLowerCase());
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString();
    const tenant = tenants.create({
      name: claims.agencyName ?? claims.email.split("@")[0],
      plan: isAdmin ? "dev" : "trial",
      trialEndsAt: isAdmin ? undefined : trialEndsAt,
    });
    user = users.create({
      id: claims.sub,
      tenantId: tenant.id,
      email: claims.email,
      role: "owner",
      platformAdmin: isAdmin,
    });
    if (isAdmin) {
      const adopted = tenants.adoptOrphanBusinesses(tenant.id);
      if (adopted) console.log(`[auth] ${claims.email} adopted ${adopted} legacy business(es)`);
    }
    onTenantCreated(tenants.get(tenant.id)!);
  }
  const tenant = tenants.get(user.tenantId);
  if (!tenant) throw new Error(`user ${user.id} references missing tenant ${user.tenantId}`);
  return { user, tenant, platformAdmin: user.platformAdmin };
}

/** Fixed context for DASHBOARD_TOKEN requests (ops, CLI, pre-SaaS deployments). */
export function opsContext(): AuthContext {
  return fixedContext("ops", "Ops", "ops@platform.local");
}

/** Fixed context for zero-config local dev. */
export function devContext(): AuthContext {
  return fixedContext("dev", "Dev Agency", "dev@localhost");
}

function fixedContext(id: string, tenantName: string, email: string): AuthContext {
  let user = users.get(id);
  if (!user) {
    const tenant = tenants.create({ id: `tnt_${id}`, name: tenantName, plan: "dev" });
    user = users.create({ id, tenantId: tenant.id, email, role: "owner", platformAdmin: true });
    onTenantCreated(tenant);
  }
  const tenant = tenants.get(user.tenantId)!;
  return { user, tenant, platformAdmin: true };
}

/**
 * Hook point for tenant-creation side effects (Twilio subaccount provisioning
 * plugs in here). Registered lazily to avoid a telephony import cycle.
 */
type TenantCreatedHook = (tenant: TenantRecord) => void;
let tenantCreatedHook: TenantCreatedHook | undefined;
export function setTenantCreatedHook(fn: TenantCreatedHook): void {
  tenantCreatedHook = fn;
}
function onTenantCreated(tenant: TenantRecord): void {
  try {
    tenantCreatedHook?.(tenant);
  } catch (err: any) {
    console.error(`[auth] tenant-created hook failed for ${tenant.id}:`, err?.message ?? err);
  }
}

export { authMode };
