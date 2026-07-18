import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const workspaceAlias = {
  "@grok-deck/shared": resolve("../../packages/shared/src/index.ts"),
  "@grok-deck/acp-client": resolve("../../packages/acp-client/src/index.ts"),
};

const externalize = externalizeDepsPlugin({
  exclude: ["@grok-deck/shared", "@grok-deck/acp-client"],
});

export default defineConfig({
  main: {
    plugins: [externalize],
    resolve: {
      alias: workspaceAlias,
    },
  },
  preload: {
    plugins: [externalize],
    resolve: {
      alias: {
        "@grok-deck/shared": workspaceAlias["@grok-deck/shared"],
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@grok-deck/shared": resolve("../../packages/shared/src/index.ts"),
      },
    },
    plugins: [react()],
  },
});
