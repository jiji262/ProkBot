#!/usr/bin/env node
import { Applications } from './applications.mjs';
import { applicationsAdmin } from './applications-api.mjs';
import { taskControlMethods } from './federation-tasks.mjs';
import http from "node:http";
import { readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "./auth.mjs";
import { Models } from "./models.mjs";
import { Speech } from "./speech.mjs";
import { VoiceConfig } from './voice-config.mjs';
import { VoiceSynthesis } from './voice-synthesis.mjs';
import { listFishVoices } from './voice-catalog.mjs';
import { Voice } from './voice.mjs';
import { pcmWav } from './voice-audio.mjs';
import { HarnessSettings } from './harness-settings.mjs';
import { Skills } from './skills.mjs';
import { ExecutionNode } from './execution-node.mjs';
import { TailcatNetwork, tailcatAdmin } from './tailcat.mjs';
import { Plugins } from './plugins.mjs';
import { Webhooks } from './webhooks.mjs';
import { Sharing } from './sharing.mjs';
import { rewriteSharingUrls } from './sharing-api.mjs';
import { Federation } from './federation.mjs';
import { federationInternal } from './federation-api.mjs';
import { DesktopCapabilities } from './desktop-capabilities.mjs';
import { DesktopBrowserProviders } from './desktop-browser.mjs';
import { MediaSettings } from './media-settings.mjs';
import { WebSettings } from './web-settings.mjs';
import { MediaServices } from '../runtime/media-services.mjs';
import { WebServices } from '../runtime/web-services.mjs';
import { mediaInternal } from './media-internal.mjs';
import { provisionTeachSkill } from '../runtime/host-teach.mjs';
import { PromptSettings } from './prompt-settings.mjs';
import { internalHostClient } from './internal-host.mjs';
import { mobileAppIntentMethods, mobileAppIntentRpc } from './mobile-app-intents.mjs';
import { adminExtensions } from './admin-extensions.mjs';
import { recentRouting } from '../runtime/routing-log.mjs';
import { todayUsage } from "../runtime/usage-ledger.mjs";
import { Profile } from "./profile.mjs";
import { Library, validateAgentId } from "./library.mjs";
import { deleteAgentsWithLibrary } from "./host-api.mjs";
import { Notifications } from "./notifications.mjs";
import { NotificationSettings } from './notification-settings.mjs';
import { PushService } from "./push-service.mjs";
import { DEFAULT_BARK_ICON_URL } from "./push-config.mjs";
import { Connectors, connectorApiMethods, mobileConnectorMethods } from "./connectors.mjs";
import { attachmentDataUrl } from "./attachments.mjs";
import { DeviceConnections, proxyHttp, proxyWebSocket } from "./proxy.mjs";
import { proxyLocalExec } from "./local-exec-proxy.mjs";
import { VncTickets, vncPath, normalizeVncUpgradeUrl } from "./vnc.mjs";
import {
  adminMutation,
  bearer,
  check,
  cookie,
  equal,
  hash,
  HttpError,
  jsonBody,
  originFor,
  RateLimit,
  securityHeaders,
  sendJson,
} from "./security.mjs";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const assetTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const pages = new Map([["/", "index.html"], ["/admin", "index.html"], ["/connectors/result", "connector-result.html"]]);
// Admin assets are served from a fixed listing taken at startup.
const publicAssets = new Set(readdirSync(publicDir).filter((name) => [".js", ".css", ".svg"].includes(extname(name))));
const adminCookie = "grokbot_admin";
const bootAt = new Date().toISOString();
function endpoint(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Server endpoint must be an HTTP(S) origin without credentials",
    );
  return url;
}
export async function createSelfHostServer(options = {}) {
  const dataDir = resolve(
    options.dataDir ?? process.env.GROKBOT_DATA_DIR ?? "/data",
  );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const hostUrl = endpoint(
    options.hostUrl ??
      process.env.GROKBOT_INTERNAL_HOST_URL ??
      "http://127.0.0.1:1340",
  );
  const publicUrl = options.publicUrl ?? process.env.GROKBOT_PUBLIC_URL;
  const canonical = publicUrl ? endpoint(publicUrl).origin : null;
  const hostDataDir = resolve(
    options.hostDataDir ??
      process.env.GROKBOT_HOST_DATA_DIR ??
      join(dataDir, "host-data"),
  );
  const attachmentUrlRoot =
    options.attachmentUrlRoot ??
    process.env.GROKBOT_ATTACHMENT_URL_ROOT ??
    hostDataDir;
  const tokenFile =
    options.tokenFile ?? process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE;
  const internalToken =
    options.internalToken ??
    (tokenFile ? (await readFile(tokenFile, "utf8")).trim() : null);
  if (internalToken && !/^[A-Za-z0-9_-]{32,256}$/.test(internalToken))
    throw new Error("Invalid internal Host credential");
  const targets = {
    desktop: endpoint(
      options.vncUrl ?? process.env.GROKBOT_VNC_URL ?? "http://127.0.0.1:6080",
    ),
    fork: endpoint(
      options.forkVncUrl ??
        process.env.GROKBOT_FORK_VNC_URL ??
        "http://127.0.0.1:6081",
    ),
  };
  const auth = await new Auth(dataDir, options.authOptions).load();
  const models = new Models(dataDir, {
    filename: options.modelFile ?? process.env.GROKBOT_MODEL_ENV,
  });
  const library = await new Library(dataDir).load();
  const speech = await new Speech(dataDir).load();
  const voiceConfig = await new VoiceConfig(dataDir, { speech }).load();
  const synthesis = new VoiceSynthesis(voiceConfig);
  const mediaSettings = await new MediaSettings(dataDir).load(), webSettings = await new WebSettings(dataDir).load();
  const mediaServices = await new MediaServices(dataDir).load(), webServices = new WebServices(dataDir);
  const harness = await new HarnessSettings(dataDir).load();
  const prompts = await new PromptSettings(dataDir).load();
  const skills = await new Skills(dataDir, { hostDataDir }).load();
  await provisionTeachSkill(skills);
  const network = await new TailcatNetwork(dataDir, options.tailcatOptions).load();
  const executionNode = await new ExecutionNode(dataDir, { network }).load();
  const profile = await new Profile(dataDir).load();
  const connectors = await new Connectors(dataDir, {
    actorActive: actor => actor?.kind === "device" ? Boolean(auth.device(actor.id)) :
      actor?.kind === "admin" && auth.store.value.sessions.some(item => item.hash === actor.hash && item.expiresAt > Date.now()),
  }).load();
  const federation = await new Federation(dataDir, { profile, network, hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const push = await new PushService(dataDir, auth, { ...options.pushOptions, enabled: () => federation.role() === "primary" }).load();
  const plugins = await new Plugins(dataDir, { connectors, skills, hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const applications = await new Applications({ connectors, plugins, hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const webhooks = await new Webhooks(dataDir).load();
  const sharing = await new Sharing(dataDir, { skills, plugins, profile, publicUrl: canonical,
    hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const notifications = await new Notifications(dataDir, { onPublish: item => push.enqueue(item) }).load();
  const notificationSettings = await new NotificationSettings(dataDir).load();
  const tickets = new VncTickets(auth, options.ticketOptions);
  const connections = new DeviceConnections();
  federation.onRoleChange = () => connections.close();
  const voice = new Voice({ config: voiceConfig, speech, synthesis, auth, connections,
    hostCall: internalHostClient(hostUrl, internalToken) });
  const desktopCapabilities = new DesktopCapabilities({ authenticate: device, connections, internalToken, enabled: () => harness.current().macComputer });
  const browserProviders = new DesktopBrowserProviders({ authenticate: device, connections, hostUrl, internalToken, enabled: key => harness.current()[key] });
  let executionRevision = executionNode.active()?.revision;
  const limiter = new RateLimit();
  const usage = timeZone => {
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
    catch { throw new HttpError(400, 'Invalid time zone'); }
    return todayUsage(join(dataDir, 'usage'), timeZone);
  };
  const sockets = new Set();
  function device(request) {
    check(federation.role() === 'primary', 403, 'Connect to the primary Host');
    const found = auth.authenticate(bearer(request));
    check(found, 401, "设备凭证无效，请重新配对");
    void auth.touch(found.id).catch(() => {});
    return found;
  }
  function admin(request) {
    check(
      auth.adminSession(cookie(request, adminCookie)),
      401,
      "请登录管理页面",
    );
  }
  function session(response, token, origin) {
    response.setHeader(
      "set-cookie",
      `${adminCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? Math.floor(auth.sessionMs / 1000) : 0}${origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  function vncAccess(request, url, path, origin) {
    check(federation.role() === 'primary', 403, 'Connect to the primary Host');
    const route = vncPath(
      path,
      request.headers.upgrade?.toLowerCase() === "websocket",
    );
    check(route, 404, "桌面资源不存在");
    let found, ticket, nativeIosTicket = false;
    if (request.headers.authorization !== undefined) {
      found = device(request);
      ticket = tickets.issue(found.id, route.slot);
    } else {
      ticket =
        url.searchParams.get("ticket") ??
        cookie(request, `grokbot_vnc_${route.slot}`);
      const value = tickets.validate(ticket, route.slot);
      check(value, 401, "桌面访问票据已失效，请重新打开电脑预览");
      found = { id: value.deviceId };
      nativeIosTicket =
        request.headers.upgrade?.toLowerCase() === "websocket" &&
        url.searchParams.get("ticket") === ticket &&
        auth.device(value.deviceId)?.platform === "ios";
    }
    check(
      !request.headers.origin || request.headers.origin === origin ||
        (request.headers.origin === "null" && nativeIosTicket),
      403,
      "桌面请求来源不匹配",
    );
    url.searchParams.delete("ticket");
    const execution = executionNode.vnc(route.slot, `${route.path}${url.search}`);
    const activeRevision = executionNode.active()?.revision;
    if (activeRevision !== executionRevision) {
      executionRevision = activeRevision; connections.close();
    }
    return {
      target: targets[route.slot],
      path: `${route.path}${url.search}`,
      ...(execution ?? {}),
      deviceId: found.id,
      ticketCookie: `grokbot_vnc_${route.slot}=${ticket}; Path=/vnc/${route.slot}/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(tickets.ttlMs / 1000)}${origin.startsWith("https:") ? "; Secure" : ""}`,
    };
  }
  async function hostStatus() {
    try {
      const result = await fetch(new URL("/api/listAgents", hostUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(internalToken
            ? { authorization: `Bearer ${internalToken}` }
            : {}),
        },
        body: "{}",
        signal: AbortSignal.timeout(1800),
        redirect: "error",
      });
      if (!result.ok) {
        await result.body?.cancel();
        return { connected: false, agents: [] };
      }
      const agents = await result.json();
      if (!Array.isArray(agents)) return { connected: false, agents: [] };
      return {
        connected: true,
        busy: agents.some((item) => item.isRunning),
        agents: agents
          .filter((item) => !item.isHiddenFromSidebar)
          .map((item) => ({
            id: item.id,
            name: item.name,
            isRunning: Boolean(item.isRunning),
            isGroup: Boolean(item.isGroup),
          })),
      };
    } catch {
      return { connected: false, agents: [] };
    }
  }
  async function verifyAgent(agentId) {
    validateAgentId(agentId);
    const status = await hostStatus();
    check(status.connected, 503, "Host 暂不可用，无法读取 Bot 资料库");
    check(
      status.agents.some((agent) => agent.id === agentId),
      404,
      "Bot 不存在",
    );
  }
  async function adminRoutes(request, response, path, origin) {
    const method = request.method;
    if (method !== "GET") adminMutation(request, origin);
    if (method === "GET" && path === "/admin/api/session") {
      return sendJson(response, 200, {
        initialized: auth.initialized,
        authenticated: auth.adminSession(cookie(request, adminCookie)),
        publicUrl: origin,
      });
    }
    if (
      method === "POST" &&
      ["/admin/api/setup", "/admin/api/login"].includes(path)
    ) {
      limiter.check(`admin:${request.socket.remoteAddress}`, 5);
      const body = await jsonBody(request);
      const token = path.endsWith("/setup")
        ? await auth.setup(body.setupKey, body.password)
        : await auth.login(body.password);
      session(response, token, origin);
      return sendJson(response, 200, { ok: true });
    }
    admin(request);
    if (method === 'GET' && path === '/admin/api/voice') return sendJson(response, 200, voiceConfig.publicConfig());
    if (method === 'PUT' && path === '/admin/api/voice') return sendJson(response, 200, await voiceConfig.save(await jsonBody(request)));
    if (method === 'POST' && path === '/admin/api/voice/voices') {
      limiter.check(`voice-catalog:${request.socket.remoteAddress}`, 30);
      const input = await jsonBody(request);
      return sendJson(response, 200, await listFishVoices(voiceConfig.resolveCatalogConfig(input.tts), input));
    }
    if (method === 'POST' && path === '/admin/api/voice/test') {
      limiter.check(`voice-test:${request.socket.remoteAddress}`, 6);
      const { text } = await jsonBody(request, 8192);
      check(typeof text === 'string' && text.length <= 300, 400, '试听文字最多 300 字');
      const abort = new AbortController(); response.on('close', () => abort.abort());
      const chunks = [];
      for await (const chunk of synthesis.stream(text, { signal: abort.signal })) chunks.push(chunk);
      const wav = pcmWav(Buffer.concat(chunks));
      response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
      return response.end(wav);
    }
    if (await tailcatAdmin(request, response, path, network)) return;
    if (await applicationsAdmin(request, response, path, applications, origin, { kind: 'admin', hash: hash(cookie(request, adminCookie)) })) return;
    if (await adminExtensions(request, response, path, { harness, skills, executionNode, plugins, webhooks, verifyAgent, sharing, federation, mediaSettings, webSettings, webServices, prompts })) return;
    if (method === 'GET' && path === '/admin/api/speech')
      return sendJson(response, 200, speech.publicConfig());
    if (method === 'PUT' && path === '/admin/api/speech')
      return sendJson(response, 200, await speech.save(await jsonBody(request)));
    if (method === 'POST' && path === '/admin/api/speech/test') {
      limiter.check(`speech-test:${request.socket.remoteAddress}`, 10);
      return speech.route(request, response);
    }
    if (path === "/admin/api/connectors" || path.startsWith("/admin/api/connectors/"))
      return sendJson(response, 200, await connectors.route("admin", method, path,
        method === "GET" ? {} : await jsonBody(request, 512 * 1024), origin,
        { kind: "admin", hash: hash(cookie(request, adminCookie)) }));
    if (method === "GET" && path === "/admin/api/profile")
      return sendJson(response, 200, profile.current());
    if (method === "PUT" && path === "/admin/api/profile")
      return sendJson(
        response,
        200,
        await profile.save(await jsonBody(request, 3 * 1024 * 1024), { allowHostName: true }),
      );
    if (method === "POST" && path === "/admin/api/logout") {
      await auth.logout(cookie(request, adminCookie));
      session(response, "", origin);
      return sendJson(response, 200, { ok: true });
    }
    if (method === "GET" && path === "/admin/api/status") {
      const [model, host] = await Promise.all([
        models.publicConfig(),
        hostStatus(),
      ]);
      return sendJson(response, 200, {
        startedAt: bootAt,
        publicUrl: origin,
        model,
        host,
        devices: push.devices(),
        pairingKeys: auth.pairingKeys(),
        notifications: {
          ...notificationSettings.current(),
          count: notifications.store.value.items.length,
          onlineSubscribers: notifications.clients.size,
          providers: [
            { id: "sse", name: "在线客户端", status: "ready" },
            { id: "bark", name: "Bark", status: "ready" },
            { id: "apns", name: "Apple APNs", status: push.config.publicConfig().ready ? "ready" : "unconfigured" },
          ],
        },
      });
    }
    if (method === "GET" && path === "/admin/api/model/routing-log")
      return sendJson(response, 200, { items: await recentRouting(join(dataDir, 'routing')) });
    if (method === "GET" && path === "/admin/api/model")
      return sendJson(response, 200, await models.publicConfig());
    if (method === "GET" && path === "/admin/api/usage")
      return sendJson(response, 200, await usage(new URL(request.url, origin).searchParams.get('timeZone') || process.env.TZ || 'UTC'));
    if (method === "PUT" && path === "/admin/api/model")
      return sendJson(
        response,
        200,
        await models.save(await jsonBody(request)),
      );
    if (method === "POST" && path === "/admin/api/model/catalog") {
      return sendJson(response, 200, await models.catalog(await jsonBody(request)));
    }
    if (method === "POST" && path === "/admin/api/model/classify") {
      limiter.check(`classifier-test:${request.socket.remoteAddress}`, 10);
      return sendJson(response, 200, await models.classify(await jsonBody(request)));
    }
    if (method === "POST" && path === "/admin/api/model/test") {
      limiter.check(`model-test:${request.socket.remoteAddress}`, 5);
      return sendJson(
        response,
        200,
        await models.test(await jsonBody(request)),
      );
    }
    if (method === "POST" && path === "/admin/api/pairing-keys")
      return sendJson(response, 201, await auth.createPairing());
    const deviceName = /^\/admin\/api\/devices\/([a-f0-9-]{36})$/.exec(path);
    if (method === "PATCH" && deviceName) {
      const body = await jsonBody(request);
      return sendJson(response, 200, await push.rename(deviceName[1], body.name));
    }
    const revoke = /^\/admin\/api\/devices\/([a-f0-9-]{36})\/revoke$/.exec(
      path,
    );
    if (method === "POST" && revoke) {
      await auth.revoke(revoke[1]);
      await push.revoke(revoke[1]);
      tickets.revoke(revoke[1]);
      connections.revoke(revoke[1]);
      return sendJson(response, 200, { ok: true });
    }
    if (path === '/admin/api/notification-settings' && ['GET', 'PUT'].includes(method))
      return sendJson(response, 200, method === 'GET' ? notificationSettings.current() : await notificationSettings.save(await jsonBody(request)));
    if (path === "/admin/api/push" && ["GET", "PUT"].includes(method))
      return sendJson(response, 200, method === "GET" ? push.config.publicConfig() : await push.config.save(await jsonBody(request)));
    const devicePush = /^\/admin\/api\/devices\/([A-Za-z0-9-]+)\/push(\/test)?$/.exec(path);
    if (devicePush && method === "PUT" && !devicePush[2]) {
      const body = await jsonBody(request);
      return sendJson(response, 200, body.provider
        ? await push.register(devicePush[1], { push: body })
        : await push.setEnabled(devicePush[1], body.enabled));
    }
    if (devicePush && method === "POST" && devicePush[2]) {
      limiter.check(`push-test:${devicePush[1]}`, 10);
      const body = await jsonBody(request); await verifyAgent(body.agentId);
      return sendJson(response, 200, await push.test(devicePush[1], body.agentId));
    }
    if (method === "POST" && path === "/admin/api/notifications/test") {
      const body = await jsonBody(request);
      const { item } = await notifications.publish({
        type: "test",
        agentId: body.agentId,
        title: "Grok Bot 通知测试",
        body: "通知已从你的 Host 发送。点击后返回对应会话。",
      });
      return sendJson(response, 201, item);
    }
    if (method === "GET" && path === "/admin/api/notifications")
      return sendJson(response, 200, {
        items: notifications.list().slice(-100).reverse(),
      });
    throw new HttpError(404, "接口不存在");
  }
  async function handle(request, response) {
    securityHeaders(response);
    check(
      request.url?.startsWith("/") && !request.url.startsWith("//"),
      400,
      "请求地址无效",
    );
    const path = request.url.split("?")[0];
    const origin = originFor(request, network.isIngress(request) ? '' : canonical);
    delete request.headers['x-grokbot-tailcat-ingress'];
    const url = new URL(request.url, origin);
    if (path.startsWith("/admin/api/"))
      return adminRoutes(request, response, path, origin);
    if (await mediaInternal(request, response, path, { internalToken, mediaServices, webServices })) return;
    if (request.method === 'POST' && ['/federation/v1/pair', '/federation/v1/sync', '/federation/v1/revoke'].includes(path)) {
      limiter.check(`federation:${request.socket.remoteAddress}`, 120);
      const envelope = await jsonBody(request, 512 * 1024);
      return sendJson(response, 200, path.endsWith('/pair') ? await federation.receivePair(envelope) : path.endsWith('/revoke') ? await federation.receiveRevocation(envelope) : await federation.receiveSync(envelope));
    }
    if (request.method === 'POST' && path.startsWith('/internal/federation/')) {
      check(internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
      return sendJson(response, 200, await federationInternal(federation, path.slice('/internal/federation/'.length), await jsonBody(request)));
    }
    const hook = /^\/hooks\/v1\/([a-f0-9-]{36})$/.exec(path);
    if (hook && request.method === 'POST') {
      const result = await webhooks.receive(request, hook[1], path);
      return sendJson(response, result.duplicate ? 200 : 202, result);
    }
    if (request.method === 'POST' && path.startsWith('/internal/webhooks/')) {
      check(internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
      const body = await jsonBody(request);
      if (path === '/internal/webhooks/claim') return sendJson(response, 200, await webhooks.claim(body.worker));
      if (path === '/internal/webhooks/finish') return sendJson(response, 200, await webhooks.finish(body));
      throw new HttpError(404, 'Unknown webhook operation');
    }
    if (request.method === 'POST' && path.startsWith('/internal/sharing/')) {
      check(internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
      return sendJson(response, 200, await sharing.internal(path.slice('/internal/sharing/'.length), await jsonBody(request, 21 * 1024 * 1024)));
    }
    if (request.method === "GET" && ["/health", "/healthz"].includes(path))
      return sendJson(response, 200, {
        ok: true,
        initialized: auth.initialized,
      });
    if (request.method === "POST" && path === "/connect/pair") {
      check(federation.role() === 'primary', 403, 'Connect to the primary Host');
      limiter.check(`pair:${request.socket.remoteAddress}`, 6);
      limiter.check("pair:global", 60);
      const result = await auth.pair(await jsonBody(request));
      return sendJson(response, 201, {
        ...result,
        gatewayUrl: origin,
        notificationUrl: `${origin}/notifications/events`,
      });
    }
    if (request.method === 'GET' && ['/local/notification-settings', '/local/notification-settings/events'].includes(path)) {
      const found = device(request); connections.track(found.id, response);
      return path.endsWith('/events') ? notificationSettings.subscribe(response) : sendJson(response, 200, notificationSettings.current());
    }
    if (request.method === "POST" && path === "/internal/notifications") {
      check(
        internalToken && equal(bearer(request), internalToken),
        401,
        "内部凭证无效",
      );
      if (federation.role() === 'member') { await jsonBody(request); return sendJson(response, 200, { delegated: true }); }
      const result = await notifications.publish(await jsonBody(request));
      return sendJson(response, result.created ? 201 : 200, result.item);
    }
    if (request.method === 'POST' && path === '/internal/audio/transcriptions') {
      check(internalToken && equal(bearer(request), internalToken), 401, '内部凭证无效');
      return speech.route(request, response);
    }
    if (request.method === 'POST' && path === '/local/audio/transcriptions') {
      const found = device(request);
      limiter.check(`speech:${found.id}`, 30);
      connections.track(found.id, response);
      return speech.route(request, response);
    }
    if (request.method === 'POST' && path === '/local/voice/session') {
      const found = device(request); limiter.check(`voice-session:${found.id}`, 10);
      const { agentId, audioProcessing } = await jsonBody(request, 2048); await verifyAgent(agentId);
      return sendJson(response, 200, voice.issue(found.id, agentId, origin, audioProcessing));
    }
    if (request.method === 'GET' && path === '/local/voice/status') {
      device(request);
      return sendJson(response, 200, { enabled: voiceConfig.publicConfig().enabled && speech.publicConfig().enabled });
    }
    if (request.method === "POST" && path.startsWith("/internal/connectors/")) {
      check(internalToken && equal(bearer(request), internalToken), 401, "内部凭证无效");
      return sendJson(response, 200, await connectors.internal(path.slice("/internal/connectors/".length), await jsonBody(request, 512 * 1024)));
    }
    if (request.method === "GET" && path === "/connectors/oauth/callback") {
      let result;
      try { result = await connectors.oauth.complete(url.searchParams); }
      catch {
        response.writeHead(303, { location: "/connectors/result?status=error" });
        return response.end();
      }
      if (result.returnTo === "admin") {
        response.writeHead(303, { location: `/admin?view=connectors&authorization=${result.ok ? "success" : "error"}` });
        return response.end();
      }
      response.writeHead(303, { location: `/connectors/result?status=${result.ok ? "success" : "error"}` });
      return response.end();
    }
    if (path === "/local/connectors" || path.startsWith("/local/connectors/")) {
      const found = device(request);
      return sendJson(response, 200, await connectors.route("local", request.method, path,
        request.method === "GET" ? {} : await jsonBody(request, 512 * 1024), origin,
        { kind: "device", id: found.id }));
    }
    if (path.startsWith('/local/app-intents/')) {
      const found = device(request), intentMethod = path.slice('/local/app-intents/'.length);
      check(request.method === 'POST' && mobileAppIntentMethods.has(intentMethod), 404, 'App Intent method not found');
      limiter.check(`app-intents:${found.id}`, 120);
      return sendJson(response, 200, await mobileAppIntentRpc(internalHostClient(hostUrl, internalToken), intentMethod,
        await jsonBody(request, 512 * 1024, { allowEmpty: true })));
    }
    if (path.startsWith("/local/mobile-rpc/")) {
      const found = device(request), method = path.slice("/local/mobile-rpc/".length);
      check(request.method === "POST" && mobileConnectorMethods.has(method), 404, "连接应用接口不存在");
      return sendJson(response, 200, await connectors.mobile(method,
        // The original client omits the body for parameterless RPC methods.
        await jsonBody(request, 512 * 1024, { allowEmpty: true }), origin, { kind: "device", id: found.id }));
    }
    if (path.startsWith("/vnc/")) {
      check(["GET", "HEAD"].includes(request.method), 405, "不支持的请求方法");
      const access = vncAccess(request, url, path, origin);
      connections.track(access.deviceId, response);
      return proxyHttp(request, response, access);
    }
    if (await desktopCapabilities.route(request, response, path)) return;
    if (await browserProviders.route(request, response, path)) return;
    if (
      proxyLocalExec(request, response, path, {
        authenticate: device,
        connections,
        hostUrl,
        internalToken,
      })
    ) return;
    if (request.method === "GET" && path === "/connect/status") {
      const found = device(request);
      return sendJson(response, 200, {
        deviceId: found.id,
        deviceName: found.name,
        platform: found.platform,
        connected: true,
      });
    }
    if (["GET", "PUT"].includes(request.method) && path === "/local/device") {
      const found = device(request);
      return sendJson(response, 200, request.method === "GET" ? push.get(found.id) : await push.register(found.id, await jsonBody(request)));
    }
    if (request.method === "GET" && path === "/local/computers") {
      device(request);
      const status = options.computers?.() ?? { available: false, computers: [] }, computers = new Map(status.computers.map(item => [item.id, item]));
      for (const item of desktopCapabilities.list()) {
        const previous = computers.get(item.machineId);
        computers.set(item.machineId, { ...previous, id: item.machineId, label: item.label, connected: true, platform: 'darwin',
          capabilities: [...new Set([...(previous?.capabilities ?? []), 'gui'])] });
      }
      return sendJson(response, 200, { available: status.available || computers.size > 0, computers: [...computers.values()] });
    }
    if (request.method === "GET" && path === "/local/usage") {
      device(request);
      return sendJson(response, 200, await usage(url.searchParams.get('timeZone') || process.env.TZ || 'UTC'));
    }
    if (["GET", "PUT"].includes(request.method) && path === "/local/profile") {
      const found = device(request);
      connections.track(found.id, response);
      const value =
        request.method === "GET"
          ? profile.current()
          : await profile.save(await jsonBody(request, 3 * 1024 * 1024));
      return sendJson(response, 200, value);
    }
    if (request.method === "GET" && path === "/local/files/content") {
      const found = device(request);
      connections.track(found.id, response);
      const agentId = url.searchParams.get("agentId");
      await verifyAgent(agentId);
      const file = await library.content({
        agentId,
        name: url.searchParams.get("name"),
      });
      if (response.destroyed) return;
      const encodedName = encodeURIComponent(file.name.toWellFormed()).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      response.writeHead(200, {
        "content-type": file.contentType,
        "content-length": file.bytes.length,
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
        "content-security-policy": "default-src 'none'; sandbox",
      });
      return response.end(file.bytes);
    }
    if (
      path === "/local/files" &&
      ["GET", "POST", "DELETE"].includes(request.method)
    ) {
      const found = device(request);
      connections.track(found.id, response);
      const body =
        request.method === "GET"
          ? { agentId: url.searchParams.get("agentId") }
          : await jsonBody(request, 29 * 1024 * 1024);
      await verifyAgent(body.agentId);
      if (request.method === "GET")
        return sendJson(response, 200, await library.list(body.agentId));
      if (request.method === "POST")
        return sendJson(response, 200, await library.upload(body));
      await library.remove(body);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && path === "/connect/attachment") {
      const found = device(request);
      connections.track(found.id, response);
      const body = await jsonBody(request);
      return sendJson(
        response,
        200,
        await attachmentDataUrl(body.url, hostDataDir, attachmentUrlRoot),
      );
    }
    if (
      request.method === "GET" &&
      ["/notifications/events", "/notifications"].includes(path)
    ) {
      const found = device(request);
      connections.track(found.id, response);
      if (path.endsWith("/events")) {
        if (found.platform === "ios" && request.headers["x-grokbot-foreground"] === "1")
          push.trackForegroundStream(found.id, response);
        return notifications.subscribe(request, response);
      }
      return sendJson(response, 200, {
        items: notifications.list(url.searchParams.get("after")),
      });
    }
    if (
      (request.method === "POST" &&
        /^\/api\/[a-zA-Z][a-zA-Z0-9]*$/.test(path)) ||
      (request.method === "GET" && path === "/events")
    ) {
      const found = device(request);
      connections.track(found.id, response);
      check(!['/api/importLocalSharedBot', '/api/localApplicationRpc'].includes(path), 403, 'Administrator operation');
      if (taskControlMethods.has(path.slice('/api/'.length))) {
        const method = path.slice('/api/'.length), input = await jsonBody(request, 64000);
        const remote = await federation.control(method, input);
        return sendJson(response, 200, remote ? { accepted: true } : await internalHostClient(hostUrl, internalToken)(method, input));
      }
      if (connectorApiMethods.has(path.slice("/api/".length)))
        return sendJson(response, 200, await connectors.original(path.slice("/api/".length),
          await jsonBody(request, 512 * 1024), origin, { kind: "device", id: found.id }));
      if (path === "/api/deleteAgents")
        return deleteAgentsWithLibrary(request, response, {
          hostUrl,
          internalToken,
          library,
        });
      return proxyHttp(request, response, {
        target: hostUrl,
        path: `${path}${url.search}`,
        token: internalToken,
        rewrite: (value) => rewriteSharingUrls(tickets.rewrite(value, found.id, origin), origin),
      });
    }
    if (request.method === 'GET' && path === '/grok-bot-icon.png') {
      response.writeHead(302, { location: DEFAULT_BARK_ICON_URL, 'cache-control': 'public, max-age=86400' });
      return response.end();
    }
    const asset = pages.get(path) ?? (publicAssets.has(path.slice(1)) ? path.slice(1) : null);
    if (asset && request.method === "GET") {
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      response.writeHead(200, { "content-type": `${assetTypes[extname(asset)]}; charset=utf-8` });
      return response.end(await readFile(join(publicDir, asset)));
    }
    throw new HttpError(404, "页面不存在");
  }
  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      sendJson(response, error.status ?? 500, {
        error: error.status ? error.message : "服务处理失败，请检查服务日志",
      });
      if (!error.status)
        console.error(`[selfhost] request failed: ${error.code ?? error.name}`);
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      request.url = normalizeVncUpgradeUrl(request.url);
      check(
        request.url?.startsWith("/") && !request.url.startsWith("//"),
        400,
        "Invalid URL",
      );
      check(
        request.headers.upgrade?.toLowerCase() === "websocket",
        400,
        "Invalid upgrade",
      );
      const origin = originFor(request, network.isIngress(request) ? '' : canonical);
      delete request.headers['x-grokbot-tailcat-ingress'];
      const url = new URL(request.url, origin);
      check(federation.role() === 'primary', 403, 'Connect to the primary Host');
      if (url.pathname === '/local/voice/realtime') return voice.upgrade(request, socket, head);
      const access = vncAccess(request, url, request.url.split("?")[0], origin);
      connections.track(access.deviceId, socket);
      proxyWebSocket(request, socket, head, access);
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status ?? 500} Rejected\r\nConnection: close\r\n\r\n`,
      );
    }
  });
  return {
    server,
    auth,
    models,
    speech,
    voice, voiceConfig, synthesis,
    mediaSettings, webSettings, mediaServices,
    harness,
    prompts,
    skills,
    executionNode,
    plugins, applications,
    webhooks,
    sharing,
    federation,
    network,
    desktopCapabilities,
    notifications,
    notificationSettings,
    push,
    connectors,
    tickets,
    library,
    profile,
    dataDir,
    async start(
      port = Number(process.env.GROKBOT_PORT ?? 8000),
      bind = process.env.GROKBOT_BIND ?? "0.0.0.0",
    ) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bind, resolve);
      });
      federation.start();
      void network.start(`127.0.0.1:${server.address().port}`).catch(() => {});
      return server.address();
    },
    async close() {
      await federation.close();
      await network.close();
      desktopCapabilities.close(); browserProviders.close();
      await voice.close(); await synthesis.close(); await voiceConfig.close();
      await speech.close();
      notifications.close();
      notificationSettings.close();
      await push.close();
      await connectors.close();
      connections.close();
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
      await Promise.all([
        auth.store.tail,
        models.tail,
        notifications.store.tail,
        notificationSettings.store.tail,
        library.tail,
        library.index.tail,
        profile.store.tail,
        harness.store.tail,
        prompts.store.tail,
        skills.store.tail,
        executionNode.store.tail,
        plugins.store.tail, plugins.operations,
        webhooks.store.tail,
        sharing.store.tail,
        mediaSettings.store.tail, webSettings.store.tail, mediaServices.store.tail,
      ]);
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const app = await createSelfHostServer();
    const address = await app.start();
    console.log(
      JSON.stringify({
        service: "grokbot-selfhost",
        port: address.port,
        initialized: app.auth.initialized,
        ...(app.auth.initialized
          ? {}
          : { setupKeyFile: join(app.dataDir, "setup-key") }),
      }),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await app.close();
        process.exit(0);
      });
  } catch (error) {
    console.error(`[selfhost] startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
