import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, writePrivate } from "../server/storage.mjs";

/** One child, one lifecycle loop. Model reloads require an atomic idle acknowledgement from Host. */
export class HostSupervisor {
  constructor({
    dataDir,
    hostUrl,
    internalToken,
    entry,
    env,
    isConfigured,
    pollMs = 2000,
    retryMs = 5000,
    stopMs = 15000,
    startupMs = 120000,
    log = (message) => console.log(`[supervisor] ${message}`),
  }) {
    Object.assign(this, {
      dataDir,
      hostUrl,
      internalToken,
      entry,
      env,
      isConfigured,
      pollMs,
      retryMs,
      stopMs,
      startupMs,
      log,
    });
    this.controller = new AbortController();
    this.stopping = false;
    this.child = null;
    this.nextStartAt = 0;
    this.pendingRevision = undefined;
    this.appliedRevision = undefined;
    this.statusTail = Promise.resolve();
    this.lastStatus = null;
    this.computerSnapshot = null;
  }
  getComputers() {
    const snapshot = this.computerSnapshot;
    if (!this.child?.connected || this.stopping || !snapshot ||
        snapshot.pid !== this.child.pid || Date.now() - snapshot.at > 15_000)
      return { available: false, computers: [] };
    return { available: snapshot.available, computers: snapshot.computers };
  }
  status(revision, status, message) {
    const key = JSON.stringify({ revision, status, message });
    if (this.lastStatus === key) return this.statusTail;
    this.lastStatus = key;
    const pending = this.statusTail
      .catch(() => {})
      .then(() =>
        writePrivate(
          join(this.dataDir, "model-reload-status.json"),
          `${JSON.stringify({ revision, status, updatedAt: new Date().toISOString(), ...(message ? { message } : {}) })}\n`,
        ),
      );
    this.statusTail = pending.catch((error) => {
      this.lastStatus = null;
      throw error;
    });
    // A process exit callback may schedule a write while no tick is awaiting it.
    this.statusTail.catch((error) =>
      this.log(`Status write failed: ${error.code ?? error.name}`),
    );
    return this.statusTail;
  }
  async request(path, method = "GET") {
    try {
      const response = await fetch(new URL(path, this.hostUrl), {
        method,
        headers: { authorization: `Bearer ${this.internalToken}` },
        redirect: "error",
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(2000),
        ]),
      });
      return response.ok
        ? await response.json()
        : (await response.body?.cancel(), null);
    } catch {
      return null;
    }
  }
  startHost(revision) {
    this.pendingRevision = revision;
    this.lastExit = null;
    this.quiescing = false;
    this.startedAt = Date.now();
    const child = spawn(process.execPath, [this.entry], {
      env: this.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    this.computerSnapshot = null;
    child.on("message", value => {
      if (this.child !== child || value?.type !== "local-computers" ||
          typeof value.available !== "boolean" || !Array.isArray(value.computers)) return;
      this.computerSnapshot = { pid: child.pid, at: Date.now(),
        available: value.available, computers: value.computers };
    });
    this.childClosed = new Promise((resolve) => {
      child.once("error", (error) =>
        this.log(`Host could not start: ${error.code ?? error.name}`),
      );
      child.once("close", (code, signal) => {
        if (this.child === child) this.child = null;
        this.nextStartAt = Date.now() + this.retryMs;
        if (!this.stopping && this.intentionalStop !== child) {
          this.lastExit = {
            code,
            signal,
            revision: this.pendingRevision ?? this.appliedRevision ?? revision,
          };
          this.log(`Host exited unexpectedly: ${signal ?? code}`);
          void this.status(
            this.lastExit.revision,
            "error",
            "Host 已退出，正在等待自动重试",
          ).catch(() => {});
        }
        resolve();
      });
    });
  }
  async stopHost() {
    const child = this.child;
    if (!child) return;
    this.intentionalStop = child;
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), this.stopMs);
    try {
      await this.childClosed;
    } finally {
      clearTimeout(deadline);
      this.intentionalStop = null;
    }
  }
  async tick() {
    const request = await readJson(
      join(this.dataDir, "model-reload-request.json"),
      null,
    );
    const revision = request?.revision ?? "initial";
    if (this.stopping) return;
    if (!this.child) {
      if (
        (await this.isConfigured()) &&
        Date.now() >= this.nextStartAt &&
        !this.stopping
      ) {
        await this.status(revision, "waiting", "正在启动 Host");
        this.startHost(revision);
      }
      return;
    }
    const child = this.child;
    const health = await this.request("/health");
    if (this.stopping || this.child !== child) return;
    // Do not accept an unrelated process which happens to hold the configured port.
    if (!health?.ok || health.pid !== child.pid) {
      if (
        this.pendingRevision === undefined ||
        Date.now() - this.startedAt > this.startupMs
      )
        await this.status(
          this.pendingRevision ?? this.appliedRevision ?? revision,
          "error",
          "Host 未响应健康检查；保留进程以避免中断现有任务",
        );
      return;
    }
    if (this.pendingRevision !== undefined) {
      this.appliedRevision = this.pendingRevision;
      this.pendingRevision = undefined;
      await this.status(this.appliedRevision, "applied");
    }
    if (revision === this.appliedRevision) {
      await this.status(this.appliedRevision, "applied");
      return;
    }
    if (health.isBusy !== false && !this.quiescing) {
      await this.status(revision, "waiting", "当前任务完成后应用模型配置");
      return;
    }
    // Host performs its own synchronous idle check and freezes new starts before acknowledging.
    const prepared = await this.request("/prepare-upgrade", "POST");
    if (this.stopping || this.child !== child) return;
    // A lost response may follow a successful freeze. Keep polling, but require
    // an explicit idle acknowledgement below before stopping the process.
    this.quiescing = prepared === null || prepared.quiescing === true;
    if (prepared?.quiescing !== true || prepared.runningTurns !== 0) {
      await this.status(
        revision,
        prepared === null ? "error" : "waiting",
        prepared === null
          ? "Host 尚未确认可应用配置，保留当前任务"
          : "当前任务完成后应用模型配置",
      );
      return;
    }
    await this.status(revision, "waiting", "正在应用模型配置");
    await this.stopHost();
    this.nextStartAt = 0;
  }
  start() {
    this.running = (async () => {
      while (!this.stopping) {
        try {
          await this.tick();
        } catch (error) {
          this.log(`Lifecycle error: ${error.code ?? error.name}`);
          await this.status(
            this.pendingRevision ?? this.appliedRevision ?? "initial",
            "error",
            "Host 启动或配置应用失败，请检查容器日志",
          ).catch(() => {});
        }
        if (!this.stopping)
          await delay(this.pollMs, undefined, {
            signal: this.controller.signal,
          }).catch(() => {});
      }
    })();
    return this;
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.controller.abort();
    this.stopPromise = (async () => {
      await this.running;
      await this.stopHost();
      await this.statusTail.catch(() => {});
    })();
    return this.stopPromise;
  }
}
