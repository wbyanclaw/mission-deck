import { createAgentEndHandler } from "./agent-end-handler.js";
import { createReplyGateHandlers } from "./reply-gate-handler.js";

export function createReplyHandlers(deps) {
  const gates = createReplyGateHandlers(deps);
  return {
    ...gates,
    onAgentEnd: createAgentEndHandler(deps)
  };
}
