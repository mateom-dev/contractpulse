import { MemoryRegistryStore } from "../src/memory-store.js";
import { describeRegistryStore } from "./store-suite.js";

describeRegistryStore("MemoryRegistryStore", async () => {
  const store = new MemoryRegistryStore();
  return {
    store,
    addWorkspace: async (slug, name) => store.addWorkspace(slug, name),
    addToken: async (workspaceId, token, label, options) => store.addToken(workspaceId, token, label, options),
    close: async () => {},
  };
});
