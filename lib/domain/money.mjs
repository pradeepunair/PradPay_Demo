function assertInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
}

export function multiplyBasisPointsHalfUp(amountMinor, basisPoints) {
  assertInteger(amountMinor, "amountMinor");
  assertInteger(basisPoints, "basisPoints");
  if (amountMinor < 0 || basisPoints < 0) {
    throw new RangeError("amountMinor and basisPoints must be non-negative");
  }

  const numerator = BigInt(amountMinor) * BigInt(basisPoints);
  return Number((numerator + 5000n) / 10000n);
}

export function formatUsd(amountMinor) {
  assertInteger(amountMinor, "amountMinor");
  const sign = amountMinor < 0 ? "-" : "";
  const absolute = Math.abs(amountMinor);
  const dollars = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${cents}`;
}

export function calculateReferenceQuote() {
  const productMinor = 27900;
  const discountMinor = 1000;
  const merchandiseMinor = productMinor - discountMinor;
  const shippingMinor = 1200;
  const taxMinor = multiplyBasisPointsHalfUp(merchandiseMinor, 825);
  const totalMinor = merchandiseMinor + shippingMinor + taxMinor;
  const budgetMinor = 31500;
  const costOfGoodsMinor = 19000;
  const shippingCostMinor = 1200;
  const processorFeeMinor = multiplyBasisPointsHalfUp(totalMinor, 290) + 30;
  const contributionMinor =
    merchandiseMinor + shippingMinor - costOfGoodsMinor - shippingCostMinor - processorFeeMinor;

  return Object.freeze({
    currency: "USD",
    productMinor,
    discountMinor,
    merchandiseMinor,
    shippingMinor,
    taxMinor,
    totalMinor,
    budgetMinor,
    remainingMinor: budgetMinor - totalMinor,
    costOfGoodsMinor,
    shippingCostMinor,
    processorFeeMinor,
    contributionMinor,
    contributionBasisMinor: merchandiseMinor + shippingMinor,
  });
}
