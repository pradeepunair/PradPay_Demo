import { multiplyBasisPointsHalfUp } from "../domain/money.mjs";

// Seller-owned, local teaching data. No catalog field is interpreted as an
// instruction, and no client/model-supplied price enters the quote calculation.
export const STUDIO_CATALOG = Object.freeze([
  { id: "aurora-pro", name: "Aurora Pro Wireless", priceMinor: 27900, batteryHours: 42, deliveryDays: 2, stock: 8 },
  { id: "harbor-studio", name: "Harbor Studio ANC", priceMinor: 28900, batteryHours: 38, deliveryDays: 2, stock: 5 },
  { id: "summit-max", name: "Summit Max", priceMinor: 32900, batteryHours: 50, deliveryDays: 2, stock: 4 },
  { id: "metro-lite", name: "Metro Lite", priceMinor: 19900, batteryHours: 18, deliveryDays: 2, stock: 12 },
  { id: "cedar-classic", name: "Cedar Classic", priceMinor: 24900, batteryHours: 35, deliveryDays: 7, stock: 6 },
  { id: "signal-one", name: "Signal One", priceMinor: 25900, batteryHours: 36, deliveryDays: 3, stock: 0 },
].map(item => Object.freeze(item)));

export const DEFAULT_STUDIO_MISSION = Object.freeze({
  category: "wireless_headphones", quantity: 1, batteryHoursMin: 30,
  deliveryDaysMax: 2, maxTotalMinor: 35000, currency: "USD",
});

const exactFields = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const integerBetween = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export function validateStudioMission(mission) {
  if (!exactFields(mission, ["category", "quantity", "batteryHoursMin", "deliveryDaysMax", "maxTotalMinor", "currency"])
    || mission.category !== "wireless_headphones" || mission.quantity !== 1 || mission.currency !== "USD"
    || !integerBetween(mission.batteryHoursMin, 1, 200)
    || !integerBetween(mission.deliveryDaysMax, 1, 30)
    || !integerBetween(mission.maxTotalMinor, 100, 1_000_000)) {
    throw new Error("INVALID_STUDIO_MISSION");
  }
  return { ...mission };
}

export function parseStudioMissionDraft({ batteryHoursMin, deliveryDaysMax, maxTotalDollars } = {}) {
  const dollars = String(maxTotalDollars ?? "");
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(dollars)) throw new Error("INVALID_STUDIO_MISSION");
  const [whole, fraction = ""] = dollars.split(".");
  return validateStudioMission({ ...DEFAULT_STUDIO_MISSION,
    batteryHoursMin: Number(batteryHoursMin), deliveryDaysMax: Number(deliveryDaysMax),
    maxTotalMinor: Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
  });
}

function economics(product) {
  const discountMinor = 1000;
  const shippingMinor = 1200;
  const merchandiseMinor = product.priceMinor - discountMinor;
  const taxMinor = multiplyBasisPointsHalfUp(merchandiseMinor, 825);
  return { productMinor: product.priceMinor, discountMinor, shippingMinor, taxMinor,
    totalMinor: merchandiseMinor + shippingMinor + taxMinor };
}

export function compareStudioCatalog(mission) {
  const terms = validateStudioMission(mission);
  const comparisons = STUDIO_CATALOG.map(product => {
    const price = economics(product);
    const reasons = [];
    if (product.stock < terms.quantity) reasons.push("OUT_OF_STOCK");
    if (product.batteryHours < terms.batteryHoursMin) reasons.push("BATTERY_BELOW_MINIMUM");
    if (product.deliveryDays > terms.deliveryDaysMax) reasons.push("DELIVERY_TOO_SLOW");
    if (price.totalMinor > terms.maxTotalMinor) reasons.push("OVER_BUDGET");
    return { productId: product.id, productName: product.name, productMinor: product.priceMinor,
      totalMinor: price.totalMinor, batteryHours: product.batteryHours,
      deliveryDays: product.deliveryDays, stock: product.stock, eligible: reasons.length === 0, reasons };
  });
  const recommendedProductId = comparisons.filter(item => item.eligible)
    .sort((a, b) => a.totalMinor - b.totalMinor || a.productId.localeCompare(b.productId))[0]?.productId ?? null;
  return { catalogVersion: 1, comparisons, recommendedProductId };
}

export function requestStudioQuote(request, mission) {
  validateStudioMission(mission);
  if (!exactFields(request, ["productId", "quantity"])
    || typeof request.productId !== "string" || request.quantity !== 1) {
    return { outcome: "refused", reason: "INVALID_REQUEST" };
  }
  const product = STUDIO_CATALOG.find(item => item.id === request.productId);
  if (!product) return { outcome: "refused", reason: "PRODUCT_NOT_FOUND" };
  const comparison = compareStudioCatalog(mission).comparisons.find(item => item.productId === product.id);
  if (!comparison.eligible) return { outcome: "refused", reason: comparison.reasons[0], reasons: comparison.reasons };
  return { outcome: "quoted", quote: {
    quoteId: `sim_quote_${product.id.replaceAll("-", "_")}_01`, productId: product.id,
    seller: "Northstar Audio", ...economics(product), currency: "USD",
    reservationReference: `sim_reservation_${product.id.replaceAll("-", "_")}_01`,
    reservationStatus: "simulated",
  } };
}
