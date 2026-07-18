import type { GrokDeckApi } from "./index";

declare global {
  interface Window {
    grokDeck: GrokDeckApi;
  }
}

export {};
