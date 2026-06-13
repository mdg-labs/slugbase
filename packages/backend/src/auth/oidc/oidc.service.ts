import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  type Configuration,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";

import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { CryptoService } from "@slugbase/shared-types";

import { AccountsService } from "../../accounts/accounts.service.js";
import { ConfigService } from "../../config/config.service.js";
import { CRYPTO } from "../../crypto/crypto.tokens.js";
import { DbService } from "../../db/db.service.js";
import { OidcRepository } from "./oidc.repository.js";
import type { PublicOidcProviderItem } from "@slugbase/shared-types";

import {
  toPublicOidcLoginProviders,
  toPublicOidcLoginProvidersFromDeployment,
} from "./oidc-public-providers.js";
import type {
  CreateOidcProviderData,
  OidcFlowState,
  OidcProviderRecord,
} from "./oidc.types.js";

interface ResolvedOidcProvider {
  id: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
}

/** OIDC scopes always requested in addition to provider-configured scopes */
const REQUIRED_SCOPES = ["openid", "email", "profile"] as const;

@Injectable()
export class OidcService {
  private readonly repo: OidcRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(CRYPTO) private readonly crypto: CryptoService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {
    this.repo = new OidcRepository(db.getOrm());
  }

  /**
   * Builds the redirect URL to the IdP authorization endpoint.
   * Returns the URL string and the flow state that must be stored in session.
   */
  async initiateAuthorization(providerId: string): Promise<{
    redirectUrl: string;
    flowState: OidcFlowState;
  }> {
    const provider = await this.getEnabledProvider(providerId);
    const config = await this.discoverClient(
      provider.issuerUrl,
      provider.clientId,
      provider.clientSecret,
    );

    const state = randomState();
    const nonce = randomNonce();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

    const callbackUrl = this.buildCallbackUrl(providerId);

    const scopes = this.mergeScopes(provider.scopes);

    const authUrl = buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl,
      scope: scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return {
      redirectUrl: authUrl.href,
      flowState: { state, nonce, codeVerifier, providerId },
    };
  }

  /**
   * Handles the IdP callback: exchanges the authorization code for tokens,
   * verifies the ID token, then upserts the user_account + oidc_account.
   * Returns the userId of the resolved (or newly created) user.
   */
  async handleCallback(
    providerId: string,
    flowState: OidcFlowState,
    currentUrl: string,
  ): Promise<string> {
    const provider = await this.getEnabledProvider(providerId);
    const config = await this.discoverClient(
      provider.issuerUrl,
      provider.clientId,
      provider.clientSecret,
    );

    const callbackUrl = this.buildCallbackUrl(providerId);

    const tokens = await authorizationCodeGrant(
      config,
      new URL(currentUrl),
      {
        pkceCodeVerifier: flowState.codeVerifier,
        expectedState: flowState.state,
        expectedNonce: flowState.nonce,
      },
      { redirect_uri: callbackUrl },
    );

    const claims = tokens.claims();
    if (!claims) throw new Error("ID token missing claims");

    const subject = claims.sub;
    const email = typeof claims.email === "string" ? claims.email : null;
    const emailVerified =
      claims.email_verified === true || claims.email_verified === "true";
    const name =
      typeof claims.name === "string"
        ? claims.name
        : typeof claims.preferred_username === "string"
          ? claims.preferred_username
          : (email ?? "OIDC User");

    const existing = await this.repo.findAccountByProviderAndSubject(
      providerId,
      subject,
    );

    if (existing) {
      return existing.userId;
    }

    let userId: string;

    if (email) {
      const existingAccount = await this.accounts.findByEmail(email);
      if (existingAccount) {
        userId = existingAccount.id;
        if (emailVerified && !existingAccount.emailVerified) {
          await this.accounts.markEmailVerified(userId);
        }
      } else {
        const newAccount = await this.accounts.createOidcAccount({
          email,
          name,
          emailVerified,
        });
        userId = newAccount.id;
      }
    } else {
      const newAccount = await this.accounts.createOidcAccount({
        email: `${subject}@oidc.local`,
        name,
        emailVerified: false,
      });
      userId = newAccount.id;
    }

    await this.repo.createAccount({ userId, providerId, subject });
    return userId;
  }

  /**
   * Creates a new OIDC provider with the client secret encrypted at rest.
   * The plaintext secret is never stored.
   */
  async createProvider(
    data: Omit<CreateOidcProviderData, "clientSecretEncrypted"> & {
      clientSecret: string;
    },
  ): Promise<OidcProviderRecord> {
    const clientSecretEncrypted = this.crypto.encrypt(data.clientSecret);
    return this.repo.createProvider({
      name: data.name,
      issuerUrl: data.issuerUrl,
      clientId: data.clientId,
      clientSecretEncrypted,
      scopes: data.scopes,
      enabled: data.enabled,
    });
  }

  /** Lists all OIDC providers (admin view - includes disabled providers). */
  async listProviders(): Promise<OidcProviderRecord[]> {
    return this.repo.listProviders();
  }

  /**
   * Public login/register provider list — id and display name only.
   * Self-hosted: enabled DB providers. Hosted interim: empty until #354.
   */
  async listPublicProviders(): Promise<PublicOidcProviderItem[]> {
    const deploymentProviders = this.config.get("OIDC_DEPLOYMENT_PROVIDERS");
    if (deploymentProviders !== undefined) {
      return toPublicOidcLoginProvidersFromDeployment(deploymentProviders);
    }

    const providers = await this.repo.listEnabledProviders();
    return toPublicOidcLoginProviders(providers);
  }

  /**
   * Updates an existing OIDC provider.
   * If a new clientSecret is provided, it is encrypted before storage.
   */
  async updateProvider(
    id: string,
    data: Omit<Parameters<OidcRepository["updateProvider"]>[1], "clientSecretEncrypted"> & {
      clientSecret?: string;
    },
  ): Promise<OidcProviderRecord> {
    const existing = await this.repo.findProviderById(id);
    if (!existing) {
      throw new NotFoundException("OIDC provider not found");
    }

    const updateData: Parameters<OidcRepository["updateProvider"]>[1] = {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.issuerUrl !== undefined && { issuerUrl: data.issuerUrl }),
      ...(data.clientId !== undefined && { clientId: data.clientId }),
      ...(data.clientSecret !== undefined && {
        clientSecretEncrypted: this.crypto.encrypt(data.clientSecret),
      }),
      ...(data.scopes !== undefined && { scopes: data.scopes }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
    };

    if (data.issuerUrl !== undefined || data.clientId !== undefined) {
      const newIssuerUrl = data.issuerUrl ?? existing.issuerUrl;
      const newClientId = data.clientId ?? existing.clientId;
      const providers = await this.repo.listProviders();
      const duplicate = providers.find(
        (p) => p.id !== id && p.issuerUrl === newIssuerUrl && p.clientId === newClientId,
      );
      if (duplicate) {
        throw new ConflictException(
          "An OIDC provider with this issuer URL and client ID already exists",
        );
      }
    }

    const updated = await this.repo.updateProvider(id, updateData);
    if (!updated) {
      throw new NotFoundException("OIDC provider not found");
    }
    return updated;
  }

  /** Deletes an OIDC provider. Returns true when deleted, false when not found. */
  async deleteProvider(id: string): Promise<void> {
    const deleted = await this.repo.deleteProvider(id);
    if (!deleted) {
      throw new NotFoundException("OIDC provider not found");
    }
  }

  /** Generates the PKCE verifier/challenge pair - exposed for testing */
  async generatePkcePair(): Promise<{
    codeVerifier: string;
    codeChallenge: string;
  }> {
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    return { codeVerifier, codeChallenge };
  }

  /** Generates a cryptographically random state value - exposed for testing */
  generateState(): string {
    return randomState();
  }

  /** Generates a cryptographically random nonce value - exposed for testing */
  generateNonce(): string {
    return randomNonce();
  }

  private usesDeploymentProviderSource(): boolean {
    return this.config.get("OIDC_DEPLOYMENT_PROVIDERS") !== undefined;
  }

  private async getEnabledProvider(
    providerId: string,
  ): Promise<ResolvedOidcProvider> {
    if (this.usesDeploymentProviderSource()) {
      const deploymentProviders = this.config.get("OIDC_DEPLOYMENT_PROVIDERS");
      const provider = deploymentProviders?.find((entry) => entry.id === providerId);
      if (!provider || !provider.enabled) {
        throw new NotFoundException("OIDC provider not found or disabled");
      }
      return provider;
    }

    const provider = await this.repo.findProviderById(providerId);
    if (!provider || !provider.enabled) {
      throw new NotFoundException("OIDC provider not found or disabled");
    }

    return {
      id: provider.id,
      name: provider.name,
      issuerUrl: provider.issuerUrl,
      clientId: provider.clientId,
      clientSecret: this.crypto.decrypt(provider.clientSecretEncrypted),
      scopes: provider.scopes,
      enabled: provider.enabled,
    };
  }

  private async discoverClient(
    issuerUrl: string,
    clientId: string,
    clientSecret: string,
  ): Promise<Configuration> {
    return discovery(new URL(issuerUrl), clientId, clientSecret);
  }

  private buildCallbackUrl(providerId: string): string {
    const base = this.config.get("APP_BASE_URL");
    return `${base}/auth/oidc/${encodeURIComponent(providerId)}/callback`;
  }

  private mergeScopes(providerScopes: string): string {
    const configured = providerScopes.split(" ").filter(Boolean);
    const merged = new Set([...REQUIRED_SCOPES, ...configured]);
    return [...merged].join(" ");
  }
}
