import { createLocalAcpApplicationPort } from "../application/local-acp-port.mjs";

export function createLocalAcpComposition({ persistence } = {}) {
  const applicationPort = createLocalAcpApplicationPort({ persistence });
  return Object.freeze({ applicationPort });
}
