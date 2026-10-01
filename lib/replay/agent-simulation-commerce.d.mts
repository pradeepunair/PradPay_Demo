export interface StudioProduct { id: string; name: string; priceMinor: number; batteryHours: number; deliveryDays: number; stock: number }
export interface StudioMission { category: "wireless_headphones"; quantity: 1; batteryHoursMin: number; deliveryDaysMax: number; maxTotalMinor: number; currency: "USD" }
export interface StudioComparison { productId: string; productName: string; productMinor: number; totalMinor: number; batteryHours: number; deliveryDays: number; stock: number; eligible: boolean; reasons: string[] }
export interface StudioQuote { quoteId: string; productId: string; seller: "Northstar Audio"; productMinor: number; discountMinor: number; shippingMinor: number; taxMinor: number; totalMinor: number; currency: "USD"; reservationReference: string; reservationStatus: "simulated" }
export const STUDIO_CATALOG: readonly Readonly<StudioProduct>[];
export const DEFAULT_STUDIO_MISSION: Readonly<StudioMission>;
export function validateStudioMission(mission: unknown): StudioMission;
export function parseStudioMissionDraft(input: { batteryHoursMin: string; deliveryDaysMax: string; maxTotalDollars: string }): StudioMission;
export function compareStudioCatalog(mission: StudioMission): { catalogVersion: number; comparisons: StudioComparison[]; recommendedProductId: string | null };
export function requestStudioQuote(request: { productId: string; quantity: number }, mission: StudioMission): { outcome: "quoted"; quote: StudioQuote } | { outcome: "refused"; reason: string; reasons?: string[] };
