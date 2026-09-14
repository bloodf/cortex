/**
 * Static resolution maps for TechIcon.
 *
 * LOBE_ICONS: slug -> @lobehub/icons brand component (AI/model brands).
 *   Imports use the per-icon `components/Mono` subpath rather than the
 *   package barrel: the barrel pulls in `features/*` -> @lobehub/fluent-emoji,
 *   which ships extensionless directory imports that vitest/jsdom cannot
 *   resolve. Mono components are pure SVGs with no extra deps.
 */
import type { ComponentType, CSSProperties } from "react";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import Claude from "@lobehub/icons/es/Claude/components/Mono";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode/components/Mono";
import Gemini from "@lobehub/icons/es/Gemini/components/Mono";
import GeminiCLI from "@lobehub/icons/es/GeminiCLI/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Mono";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import Mistral from "@lobehub/icons/es/Mistral/components/Mono";
import Cohere from "@lobehub/icons/es/Cohere/components/Mono";
import Groq from "@lobehub/icons/es/Groq/components/Mono";
import Perplexity from "@lobehub/icons/es/Perplexity/components/Mono";
import HuggingFace from "@lobehub/icons/es/HuggingFace/components/Mono";
import XAI from "@lobehub/icons/es/XAI/components/Mono";
import Qwen from "@lobehub/icons/es/Qwen/components/Mono";
import Moonshot from "@lobehub/icons/es/Moonshot/components/Mono";
import Kimi from "@lobehub/icons/es/Kimi/components/Mono";
import Zhipu from "@lobehub/icons/es/Zhipu/components/Mono";
import LobeHub from "@lobehub/icons/es/LobeHub/components/Mono";
import LmStudio from "@lobehub/icons/es/LmStudio/components/Mono";
import Vllm from "@lobehub/icons/es/Vllm/components/Mono";
import Stability from "@lobehub/icons/es/Stability/components/Mono";
import Midjourney from "@lobehub/icons/es/Midjourney/components/Mono";
import Flux from "@lobehub/icons/es/Flux/components/Mono";
import ComfyUI from "@lobehub/icons/es/ComfyUI/components/Mono";
import Gradio from "@lobehub/icons/es/Gradio/components/Mono";
import Automatic from "@lobehub/icons/es/Automatic/components/Mono";
import Nvidia from "@lobehub/icons/es/Nvidia/components/Mono";
import Copilot from "@lobehub/icons/es/Copilot/components/Mono";
import GithubCopilot from "@lobehub/icons/es/GithubCopilot/components/Mono";
import Github from "@lobehub/icons/es/Github/components/Mono";
import VertexAI from "@lobehub/icons/es/VertexAI/components/Mono";

type IconComponent = ComponentType<{
  size?: string | number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  role?: string;
}>;

export const LOBE_ICONS: Record<string, IconComponent> = {
  // AI gateways / model providers
  durindoor: OpenAI,
  "9router": OpenAI,
  openai: OpenAI,
  anthropic: Anthropic,
  claude: Claude,
  "claude-code": ClaudeCode,
  gemini: Gemini,
  "gemini-cli": GeminiCLI,
  "vertex-ai": VertexAI,
  deepseek: DeepSeek,
  ollama: Ollama,
  mistral: Mistral,
  cohere: Cohere,
  groq: Groq,
  perplexity: Perplexity,
  "hugging-face": HuggingFace,
  huggingface: HuggingFace,
  xai: XAI,
  qwen: Qwen,
  moonshot: Moonshot,
  kimi: Kimi,
  zhipu: Zhipu,
  "lm-studio": LmStudio,
  lmstudio: LmStudio,
  vllm: Vllm,
  nvidia: Nvidia,
  copilot: Copilot,
  "github-copilot": GithubCopilot,
  github: Github,
  // LobeHub apps
  "lobe-chat": LobeHub,
  lobehub: LobeHub,
  "lobe-vidol": LobeHub,
  // Image generation
  stability: Stability,
  "stable-diffusion": Stability,
  "sd-webui": Automatic,
  midjourney: Midjourney,
  flux: Flux,
  comfyui: ComfyUI,
  "comfy-ui": ComfyUI,
  gradio: Gradio,
};
