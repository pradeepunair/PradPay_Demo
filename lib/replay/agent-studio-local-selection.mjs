import { createLMStudioDecisions } from '../agents/openai-decisions.mjs';
import { STUDIO_CATALOG, compareStudioCatalog, validateStudioMission } from './agent-simulation-commerce.mjs';

export class LocalSelectionError extends Error {
  constructor(code, status = 422) { super(code); this.code = code; this.status = status; }
}

export async function suggestStudioProduct(mission, { decisions } = {}) {
  let terms;
  try { terms = validateStudioMission(mission); }
  catch { throw new LocalSelectionError('INVALID_STUDIO_MISSION', 400); }
  const comparison = compareStudioCatalog(terms);
  if (!comparison.comparisons.some(item => item.eligible)) {
    throw new LocalSelectionError('NO_ELIGIBLE_PRODUCT');
  }
  const catalog = STUDIO_CATALOG.map(item => ({
    id: item.id, name: item.name, priceMinor: item.priceMinor,
    stock: comparison.comparisons.find(candidate => candidate.productId === item.id).eligible ? item.stock : 0,
  }));
  const model = decisions ?? createLMStudioDecisions({
    modelId: process.env.PAYMENTLAB_LOCAL_MODEL_ID,
    baseUrl: process.env.PAYMENTLAB_LOCAL_MODEL_URL || 'http://127.0.0.1:1234',
    apiToken: process.env.LM_STUDIO_API_TOKEN || undefined,
    timeoutMs: 20_000,
  });
  const result = await model.chooseProduct(
    `Choose one in-stock wireless headphone. Require at least ${terms.batteryHoursMin} battery hours, delivery within ${terms.deliveryDaysMax} days, and final total no more than ${terms.maxTotalMinor} USD cents. Do not purchase.`,
    catalog,
  );
  if (!comparison.comparisons.some(item => item.productId === result.productId && item.eligible)) {
    throw new LocalSelectionError('LOCAL_SELECTION_INVALID');
  }
  return { productId: result.productId, model: result.model, provider: 'lmstudio', paymentCalls: 0 };
}
