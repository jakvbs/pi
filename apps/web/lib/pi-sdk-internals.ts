import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import { getPackageDir, type InlineExtension } from "@earendil-works/pi-coding-agent";

// The CLI's /llama command needs its TUI. Load just its provider for the web.
export const llamaCppExtension: InlineExtension = {
  name: "llama.cpp",
  builtin: true,
  async factory(pi) {
    const path = join(getPackageDir(), "dist/extensions/llama/provider.js");
    const { createLlamaProvider } = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(path).href)) as {
      createLlamaProvider(): { provider: Provider };
    };
    pi.registerProvider(createLlamaProvider().provider);
  },
};
