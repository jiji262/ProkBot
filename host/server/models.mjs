import { parseModelPolicy, defaultPolicy, validatePolicy, effortLevels, reasoningOptions } from '../runtime/model-policy.mjs';
import { createModelRouter } from '../runtime/model-router.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { check } from "./security.mjs";
import { readJson, writePrivate } from "./storage.mjs";

const clean = (value, label, maximum = 2048) => {
  check(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= maximum &&
      !/[\r\n\0]/.test(value),
    400,
    `${label}不能为空，也不能包含换行`,
  );
  return value.trim();
};
export class Models {
  constructor(dataDir, { filename = join(dataDir, "model.env") } = {}) {
    this.filename = filename;
    this.dataDir = dataDir;
    this.tail = Promise.resolve();
  }
  async current() {
    const filename = this.filename;
    const source = await readFile(filename, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const values = Object.fromEntries(
      source
        .split(/\r?\n/)
        .filter((line) => line.includes("=") && !line.startsWith("#"))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    return {
      baseUrl: values.OPENAI_BASE_URL ?? "",
      model: values.OPENAI_MODEL ?? "",
      apiKey: values.OPENAI_API_KEY ?? "",
      contextWindowTokens: Number(values.OPENAI_CONTEXT_WINDOW_TOKENS ?? 0),
      policy: parseModelPolicy(values.GROKBOT_MODEL_POLICY, values.OPENAI_MODEL || undefined),
      jevApiKey: values.JEV_API_KEY || "",
    };
  }
  async publicConfig() {
    const { apiKey, jevApiKey, ...config } = await this.current();
    return {
      ...config,
      hasApiKey: Boolean(apiKey),
      hasJevApiKey: Boolean(jevApiKey),
      configured: Boolean(config.baseUrl && config.model && apiKey),
      reload: await this.reloadStatus(),
    };
  }
  async reloadStatus() {
    const request = await readJson(
      join(this.dataDir, "model-reload-request.json"),
      null,
    );
    const status = await readJson(
      join(this.dataDir, "model-reload-status.json"),
      null,
    );
    if (!request) return status ?? { status: "none" };
    if (status?.revision === request.revision) {
      const allowed = ["applied", "waiting", "error", "pending"];
      return {
        revision: status.revision,
        status: allowed.includes(status.status) ? status.status : "pending",
        updatedAt: status.updatedAt,
        message:
          status.status === "error"
            ? "Host 未能应用配置，请检查服务日志"
            : undefined,
      };
    }
    return {
      revision: request.revision,
      status: "pending",
      updatedAt: request.requestedAt,
    };
  }
  async validated(input) {
    const previous = await this.current();
    const baseUrl = clean(input.baseUrl, "Base URL");
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      check(false, 400, "Base URL 格式不正确");
    }
    check(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      400,
      "Base URL 需要 HTTP(S) 地址，不能包含凭证或查询参数",
    );
    const model = clean(input.model, "模型名称", 256);
    const apiKey = clean(input.apiKey || previous.apiKey, "API Key", 8192);
    const contextWindowTokens = Number(
      input.contextWindowTokens ?? previous.contextWindowTokens ?? 0,
    );
    check(
      Number.isSafeInteger(contextWindowTokens) &&
        contextWindowTokens >= 0 &&
        contextWindowTokens <= 100_000_000,
      400,
      "上下文长度应为 0–100000000 的整数",
    );
    let policy;
    try { policy = validatePolicy(input.policy ?? (previous.model === model ? previous.policy : defaultPolicy(model)), model); }
    catch (error) { check(false, 400, error.message); }
    const jevApiKey = input.jevApiKey ? clean(input.jevApiKey, "Jev API Key", 8192) : previous.jevApiKey;
    check(policy.mode !== 'adaptive' || jevApiKey, 400, '请填写 Jev API Key');
    return {
      policy, jevApiKey,
      baseUrl: url.href.replace(/\/$/, ""),
      model,
      apiKey,
      contextWindowTokens,
    };
  }
  save(input) {
    const pending = this.tail.then(async () => {
      const config = await this.validated(input);
      await writePrivate(
        this.filename,
        [
          `OPENAI_BASE_URL=${config.baseUrl}`,
          `OPENAI_API_KEY=${config.apiKey}`,
          `OPENAI_MODEL=${config.model}`,
          `OPENAI_CONTEXT_WINDOW_TOKENS=${config.contextWindowTokens}`,
          `GROKBOT_MODEL_POLICY=${JSON.stringify(config.policy)}`,
          `JEV_API_KEY=${config.jevApiKey}`,
          "",
        ].join("\n"),
      );
      const request = {
        revision: randomUUID(),
        requestedAt: new Date().toISOString(),
      };
      await writePrivate(
        join(this.dataDir, "model-reload-request.json"),
        `${JSON.stringify(request)}\n`,
      );
      return this.publicConfig();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  async catalog(input) {
    const previous = await this.current();
    const config = await this.validated({ ...previous, ...input });
    let response;
    try { response = await fetch(`${config.baseUrl}/models`, { redirect: 'error',
      headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15000) }); }
    catch { check(false, 502, '无法读取模型列表'); }
    check(response.ok, 502, `Model catalog HTTP ${response.status}`);
    const body = await response.json();
    check(Array.isArray(body.data), 502, '模型列表格式不兼容');
    return { models: body.data.filter(item => typeof item.id === 'string').slice(0, 100).map(item => {
      const supplied = item.supported_reasoning_efforts ?? item.reasoning_effort?.values ?? item.capabilities?.reasoning_efforts;
      const levels = Array.isArray(supplied) ? supplied.filter(level => ['none','low','medium','high','xhigh','max'].includes(level)) : null;
      return { id: item.id, efforts: levels ?? effortLevels(item.id), source: levels ? 'provider' : effortLevels(item.id).length ? 'reference' : 'manual' };
    }) };
  }
  async classify(input) {
    const config = await this.validated(input);
    check(config.jevApiKey, 400, '请填写 Jev API Key');
    const route = createModelRouter({ ...config, policy: { ...config.policy, mode: 'adaptive' }, usageDirectory: join(this.dataDir, 'usage'), routingDirectory: join(this.dataDir, 'routing'), routingSource: 'test' });
    const decision = await route({ messages: [{ role: 'user', content: clean(input.task, '任务', 10000) }] });
    const { requestOptions, ...result } = decision;
    return result;
  }
  async test(input) {
    const config = await this.validated(input);
    let response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          ...reasoningOptions(config.model, config.policy.effort),
          model: config.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1024,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
    } catch {
      check(false, 502, "模型服务连接失败或超时，请检查地址与网络");
    }
    if (!response.ok) {
      await response.body?.cancel();
      check(
        false,
        502,
        `模型服务返回 HTTP ${response.status}，请检查模型名称和 API Key`,
      );
    }
    const body = await response.json().catch(() => null);
    check(body?.choices?.length, 502, "模型服务返回的格式不兼容");
    await recordUsage(join(this.dataDir, 'usage'), { raw: body.usage, model: body.model ?? config.model, kind: 'test', requestId: body.id });
    return { ok: true, model: config.model, message: "模型接口已完成真实请求" };
  }
}
