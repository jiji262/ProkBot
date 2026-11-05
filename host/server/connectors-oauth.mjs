import { randomBytes, createHash } from "node:crypto";
import { check } from "./security.mjs";

const digest = (value) =>
  createHash("sha256").update(value).digest("base64url");
const tokenString = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 16384 &&
  !/[\r\n\0]/.test(value);
export class ConnectorOAuth {
  constructor(
    store,
    { fetcher = fetch, actorActive = () => true, changed = () => {} } = {},
  ) {
    this.store = store;
    this.fetch = fetcher;
    this.actorActive = actorActive;
    this.changed = changed;
    this.refreshes = new Map();
  }
  async begin(id, origin, actor, returnTo = "client") {
    const row = this.store.find(id);
    check(
      row.enabled && row.auth.type === "oauth2",
      400,
      "此连接器未配置 OAuth",
    );
    check(
      actor && ["admin", "client"].includes(returnTo),
      400,
      "授权上下文无效",
    );
    check(row.auth.clientId && row.auth.clientId !== "unconfigured", 400, "请先配置应用的 OAuth Client ID");
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    const redirectUri = new URL("/connectors/oauth/callback", origin).href,
      expiresAt = Date.now() + 10 * 60_000;
    await this.store.mutate(
      (data) => {
        data.states = data.states.filter((s) => s.expiresAt > Date.now());
        check(data.states.length < 100, 429, "未完成授权过多");
        data.states.push({
          hash: digest(state),
          expiresAt,
          details: this.store.seal({
            id: row.id,
            verifier,
            redirectUri,
            actor,
            returnTo,
            configRevision: row.updatedAt,
          }),
        });
      },
      { configuration: false },
    );
    const url = new URL(row.auth.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", row.auth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", digest(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (row.auth.scopes.length)
      url.searchParams.set("scope", row.auth.scopes.join(" "));
    if (row.auth.resource) url.searchParams.set("resource", row.auth.resource);
    return { authorizationUrl: url.href, stateId: state, expiresAt };
  }
  async exchange(row, params) {
    const body = new URLSearchParams({
      ...params,
      client_id: row.auth.clientId,
    });
    const secret = this.store.unseal(row.clientSecret);
    if (secret) body.set("client_secret", secret);
    if (row.auth.resource) body.set("resource", row.auth.resource);
    let response;
    try {
      response = await this.fetch(row.auth.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      check(false, 502, "授权服务连接失败或超时");
    }
    check(response.ok, 502, `授权服务返回 HTTP ${response.status}`);
    const raw = await response.text();
    check(raw.length <= 64_000, 502, "授权响应过大");
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      check(false, 502, "授权服务响应格式无效");
    }
    check(
      tokenString(result.access_token) &&
        String(result.token_type).toLowerCase() === "bearer",
      502,
      "授权服务未返回 Bearer 凭证",
    );
    check(
      result.refresh_token === undefined || tokenString(result.refresh_token),
      502,
      "刷新凭证无效",
    );
    const seconds =
      result.expires_in === undefined ? 3600 : Number(result.expires_in);
    check(
      Number.isFinite(seconds) && seconds > 0 && seconds <= 365 * 86400,
      502,
      "凭证有效期无效",
    );
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + seconds * 1000,
    };
  }
  async complete(query) {
    const state = query.get("state");
    check(
      typeof state === "string" && /^[A-Za-z0-9_-]{43}$/.test(state),
      400,
      "OAuth state 无效",
    );
    let detail, expiresAt;
    await this.store.mutate(
      (data) => {
        const index = data.states.findIndex((s) => s.hash === digest(state));
        check(index >= 0, 400, "授权状态不存在或已使用");
        const [stored] = data.states.splice(index, 1);
        expiresAt = stored.expiresAt;
        detail = this.store.unseal(stored.details);
      },
      { configuration: false },
    );
    check(expiresAt > Date.now(), 400, "授权已过期");
    check(await this.actorActive(detail.actor), 403, "发起授权的会话已撤销");
    const row = this.store.find(detail.id);
    check(
      row.updatedAt === detail.configRevision,
      409,
      "连接器配置已改变，请重新授权",
    );
    if (query.has("error")) return { ok: false, returnTo: detail.returnTo };
    if (row.auth.issuer)
      check(
        query.get("iss") === row.auth.issuer,
        400,
        "授权服务 Issuer 不匹配",
      );
    const code = query.get("code");
    check(tokenString(code), 400, "授权码无效");
    const tokens = await this.exchange(row, {
      grant_type: "authorization_code",
      code,
      redirect_uri: detail.redirectUri,
      code_verifier: detail.verifier,
    });
    await this.store.mutate(() => {
      check(this.store.find(row.id) === row, 409, "连接器配置已改变");
      row.credential = this.store.seal(tokens);
      row.installed = true;
    });
    await this.changed(row.id);
    return { ok: true, returnTo: detail.returnTo };
  }
  async headers(row) {
    if (row.auth.type === "none") return {};
    let credential = this.store.unseal(row.credential);
    check(credential, 401, "连接器需要授权");
    if (
      row.auth.type === "oauth2" &&
      credential.expiresAt < Date.now() + 30_000
    ) {
      if (!this.refreshes.has(row.id)) {
        const task = (async () => {
          check(credential.refreshToken, 401, "连接器授权已过期，请重新授权");
          let next;
          try {
            next = await this.exchange(row, {
              grant_type: "refresh_token",
              refresh_token: credential.refreshToken,
            });
          } catch {
            await this.store.update(row, () => {
              row.credential = undefined;
            });
            throw new Error("连接器授权刷新失败，请重新授权");
          }
          next.refreshToken ??= credential.refreshToken;
          await this.store.mutate(
            () => {
              check(this.store.find(row.id) === row, 409, "连接器配置已改变");
              row.credential = this.store.seal(next);
            },
            { configuration: false },
          );
          return next;
        })().finally(() => this.refreshes.delete(row.id));
        this.refreshes.set(row.id, task);
      }
      credential = await this.refreshes.get(row.id);
    }
    return row.auth.type === "api-key"
      ? { [row.auth.headerName]: credential.secret }
      : {
          authorization: `Bearer ${row.auth.type === "oauth2" ? credential.accessToken : credential.secret}`,
        };
  }
}
