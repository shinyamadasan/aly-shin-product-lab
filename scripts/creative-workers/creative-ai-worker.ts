import { createCreativeAiExecutor } from "../../src/lib/creative-generation/creative-ai-executor.ts";
import { buildDefaultCreativeAiRoutes, type CreativeAiRoute } from "../../src/lib/creative-generation/ai-orchestrator.ts";
import { ClaudeCliProvider } from "../../src/lib/ai/providers/claude-cli-provider.ts";
import { CodexCliProvider } from "../../src/lib/ai/providers/codex-cli-provider.ts";
import type { CreativeJobExecutor } from "../../src/lib/creative-jobs.ts";
import { loadCreativeAiGrounding, type CreativeAiGroundingReadClient } from "./creative-ai-grounding.ts";

// Content Creation MVP S3E-A2 -- the one place that decides what "real" means for creative_ai.
//
// Deliberately its OWN module rather than more wiring inside runner.ts. runner.ts is the generic
// trusted-worker composition point and is asserted provider-free by
// tests/creative-worker-runner.test.ts -- a boundary worth keeping, because it is what stops
// provider knowledge from leaking into the job machinery. Concentrating every provider reference
// here means exactly one file knows which CLIs exist, and the executor itself stays injectable and
// fully offline-testable.
//
// SUBSCRIPTION-ONLY, unchanged from S3C-B/S3C-C. Each provider authenticates through its own CLI's
// existing subscription session -- Claude CLI against a Claude subscription, Codex CLI against a
// ChatGPT subscription. No ANTHROPIC_API_KEY, no OPENAI_API_KEY, no SDK, no paid per-call API, and
// no API fallback is introduced anywhere in this path. Neither provider's internals are modified.
//
// Routes are the S3C-D defaults: Claude/opus first, Codex/gpt-5.6-sol as fallback. Ordering,
// retries and fallback are entirely S3C-D's; nothing here re-implements them.
export function createTrustedCreativeAiExecutor(
  client: CreativeAiGroundingReadClient,
  options: { now?: () => number; routes?: readonly CreativeAiRoute[] } = {},
): CreativeJobExecutor {
  const routes = options.routes ?? buildDefaultCreativeAiRoutes({ claude: new ClaudeCliProvider(), codex: new CodexCliProvider() });

  return createCreativeAiExecutor({
    routes,
    now: options.now,
    loadGrounding: async () => {
      const loaded = await loadCreativeAiGrounding(client, { now: options.now });
      if (!loaded.ok) {
        // A grounding read failure is infrastructure, not AI exhaustion: nothing was attempted and
        // there is no trace, so reporting it as an expected AI outcome would be a lie about what
        // happened. Throwing puts it on the runner's unexpected-exception path, where it belongs.
        throw new Error(loaded.message);
      }
      return loaded.grounding;
    },
  });
}
