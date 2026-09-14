// Product Lab MCP Slice 2.1A -- bridges Product Lab's owner authentication
// (scripts/product-lab/auth.ts) to the MCP SDK's OAuth Resource Server surface
// (OAuthTokenVerifier / AuthInfo from @modelcontextprotocol/server).
//
// The ONE authorization decision -- is this caller the Product Lab owner -- happens exactly once,
// inside authenticateProductLabRequest, via a real round trip to Supabase Auth. Everything this file
// adds on top (expiresAt/scopes/clientId, decoded locally from the already-verified token) is MCP
// protocol bookkeeping only; none of it is trusted for authorization. The verified owner context
// (an already-authenticated Supabase client bound to this one request) travels in AuthInfo.extra so
// the per-request McpServerFactory never re-authenticates for the same HTTP exchange.
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import {
  authenticateProductLabRequest,
  ProductLabError,
  type ProductLabOwnerContext,
  type ProductLabProjectConfig,
} from "../product-lab/auth.ts";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const segments = token.split(".");
    if (segments.length !== 3) return null;
    const json = Buffer.from(segments[1], "base64url").toString("utf8");
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createProductLabOAuthTokenVerifier(config: ProductLabProjectConfig): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let context: ProductLabOwnerContext;
      try {
        context = await authenticateProductLabRequest(config, token);
      } catch (error) {
        // Never surface WHY (missing vs. expired vs. non-owner) to an unauthenticated caller -- same
        // stable-category discipline docs/PRODUCT_LAB_MCP.md already requires of the stdio tools.
        const message = error instanceof ProductLabError
          ? "Product Lab owner authentication failed"
          : "Invalid or expired token";
        throw new OAuthError(OAuthErrorCode.InvalidToken, message);
      }

      const claims = decodeJwtPayload(token);
      const expiresAt = typeof claims?.exp === "number" ? claims.exp : Math.floor(Date.now() / 1000) + 60;
      const scope = typeof claims?.scope === "string" ? claims.scope : "";
      const clientId = typeof claims?.client_id === "string"
        ? claims.client_id
        : typeof claims?.azp === "string"
          ? claims.azp
          : "unknown";

      return {
        token,
        clientId,
        scopes: scope.length > 0 ? scope.split(/\s+/) : [],
        expiresAt,
        extra: { ownerContext: context },
      };
    },
  };
}

// Recovers the already-authenticated owner context an McpServerFactory needs to build request-scoped
// services. Throws (fails closed) rather than falling back to any process-global identity if, for any
// reason, a factory runs without AuthInfo -- that must never happen under createMcpHandler, which
// only ever calls the factory after the bearer-auth gate has produced a verified AuthInfo, but this
// function does not assume its caller enforced that.
export function ownerContextFromAuthInfo(authInfo: AuthInfo | undefined): ProductLabOwnerContext {
  const context = authInfo?.extra?.ownerContext as ProductLabOwnerContext | undefined;
  if (!context) {
    throw new ProductLabError("authentication_failed", "Request is missing verified owner context");
  }
  return context;
}
