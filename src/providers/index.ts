import type { Env } from "../config/env.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import type { FetchFn, Provider } from "./types.js";

/** Every provider with credentials in the environment, plus the mock provider for demos. */
export function createProviders(env: Env, fetchFn: FetchFn = fetch): Map<string, Provider> {
  const providers = new Map<string, Provider>([["mock", new MockProvider()]]);
  if (env.OPENAI_API_KEY) {
    providers.set("openai", new OpenAIProvider(env.OPENAI_API_KEY, fetchFn));
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.set("anthropic", new AnthropicProvider(env.ANTHROPIC_API_KEY, fetchFn));
  }
  if (env.GEMINI_API_KEY) {
    providers.set("gemini", new GeminiProvider(env.GEMINI_API_KEY, fetchFn));
  }
  if (env.OLLAMA_BASE_URL) {
    // Ollama speaks the OpenAI chat completions protocol, so the OpenAI adapter covers it.
    providers.set("ollama", new OpenAIProvider("ollama", fetchFn, env.OLLAMA_BASE_URL, "ollama"));
  }
  return providers;
}
