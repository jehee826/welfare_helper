import { createHttpApi } from "./httpApi";
import { createMockApi } from "./mockApi";
import type { WelfareApi } from "./types";

export const api: WelfareApi = import.meta.env.VITE_USE_MOCK === "true" ? createMockApi() : createHttpApi();
