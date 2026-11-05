import { check, jsonBody, sendJson } from "./security.mjs";
import { validateAgentId } from "./library.mjs";

/** Preserve the original deleteAgents reply, then remove its local reference files. */
export async function deleteAgentsWithLibrary(
  request,
  response,
  { hostUrl, internalToken, library },
) {
  const body = await jsonBody(request);
  check(
    Array.isArray(body.ids) && body.ids.length <= 1000,
    400,
    "Bot ID 列表无效",
  );
  for (const id of body.ids) validateAgentId(id);
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  let upstream;
  try {
    upstream = await fetch(new URL("/api/deleteAgents", hostUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(internalToken ? { authorization: `Bearer ${internalToken}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    return sendJson(response, 502, { error: "Host 暂不可用，请稍后重试" });
  }
  const value = await upstream.json();
  if (upstream.ok) await library.removeAgents(body.ids);
  sendJson(response, upstream.status, value);
}
