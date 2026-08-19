import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { AssistantMessageEvent } from "@github/copilot-sdk";
import { PiScrubber } from "@nrs/auth";

const scrubber = new PiScrubber();

let client: CopilotClient | undefined;
let defaultModel = "claude-sonnet-5";

/** Set the model to use for AI calls. */
export function setModel(model: string): void {
  defaultModel = model;
}

export const DEFAULT_AI_TIMEOUT_MS = 120_000;
const MIN_AI_TIMEOUT_MS = 60_000;
const MAX_AI_TIMEOUT_MS = 600_000;

/**
 * Per-call AI timeout. Live backlog runs showed legitimate planning calls
 * exceeding the old hard-coded 120s regardless of model tier, so the
 * ceiling is operator-tunable via RAVEN_AI_TIMEOUT_MS — clamped to
 * [60s, 600s] so a typo can't hang a scheduled run indefinitely or make
 * every call fail instantly.
 */
export function aiTimeoutMs(): number {
  const raw = process.env["RAVEN_AI_TIMEOUT_MS"];
  if (!raw) return DEFAULT_AI_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_AI_TIMEOUT_MS;
  return Math.min(MAX_AI_TIMEOUT_MS, Math.max(MIN_AI_TIMEOUT_MS, n));
}

/** Get or create the Copilot client. */
async function getClient(): Promise<CopilotClient> {
  if (client) return client;
  client = new CopilotClient({ logLevel: "error" });
  await client.start();
  return client;
}

/** Stop the Copilot client. Call this when the pipeline is done. */
export async function stopAI(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

/**
 * List available models from the Copilot account.
 */
export async function listModels(): Promise<void> {
  const c = await getClient();
  const models = await c.listModels();
  console.log(`Available models (${models.length}):`);
  for (const m of models) {
    console.log(`  ${m.id} (${m.name})`);
  }
}

/**
 * Send a prompt to the AI model via GitHub Copilot SDK.
 * All user content is PI-scrubbed before sending.
 * Returns the assistant's text response.
 */
export async function askAI(
  prompt: string,
  systemPrompt?: string
): Promise<string> {
  const c = await getClient();

  const session = await c.createSession({
    model: defaultModel,
    onPermissionRequest: approveAll,
    systemMessage: systemPrompt
      ? { mode: "replace", content: systemPrompt }
      : undefined,
    // Disable built-in tools — we only want text responses
    availableTools: [],
    infiniteSessions: { enabled: false },
  });

  const scrubbedPrompt = scrubber.scrubText(prompt);

  // Collect the response
  let responseText = "";
  const done = new Promise<void>((resolve, reject) => {
    const timeoutMs = aiTimeoutMs();
    const timeout = setTimeout(() => {
      reject(new Error(`AI response timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    session.on("assistant.message", (event: AssistantMessageEvent) => {
      responseText = event.data.content;
    });

    session.on("session.idle", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // try/finally so the session is always cleaned up — including when
  // `send()` throws or `done` rejects on timeout. Without this, watch /
  // backlog modes leaked Copilot sessions on every failure and could
  // exhaust local resources after long runs.
  try {
    await session.send({ prompt: scrubbedPrompt });
    await done;
  } finally {
    // deleteSession (not disconnect): sessions are single-use here, and
    // disconnect would leave each one's state on disk to accumulate.
    try { await c.deleteSession(session.sessionId); } catch { /* best-effort cleanup */ }
  }

  return responseText;
}
