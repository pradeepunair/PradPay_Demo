import { calculateReferenceQuote } from "../domain/money.mjs";
import { STUDIO_CATALOG } from "./agent-simulation-commerce.mjs";
// M1 contracts coexist with this 12-step presentation until the M2 shell is
// switched to reducer projections. The legacy exports below stay unchanged.
export { createAgentScenario } from "./agent-simulation-fixtures.mjs";
export { projectAgentScenario } from "./agent-simulation-reducer.mjs";
export { validateScenario, SCENARIO_VERSION, simulationTime } from "./agent-simulation-contracts.mjs";
export { STUDIO_CATALOG, DEFAULT_STUDIO_MISSION, compareStudioCatalog,
  parseStudioMissionDraft, requestStudioQuote } from "./agent-simulation-commerce.mjs";
export const quote = calculateReferenceQuote();

// A local teaching simulation. No provider, wallet or model SDK is imported.
export const catalog = STUDIO_CATALOG.map(item => ({ id: item.id, name: item.name,
  price: item.priceMinor, battery: item.batteryHours, delivery: item.deliveryDays, stock: item.stock }));
export const exchanges = [
  { kind:'connection', from:'Buyer', to:'Atlas', title:'Demo session opened', detail:'A fictional buyer enters Atlas. No account or password is collected.', payload:{session:'sim_buyer_01',agent:'Atlas',mode:'simulation'} },
  { kind:'permission', from:'Buyer', to:'Wallet', title:'Wallet connected, spending not approved', detail:'Atlas can request permission to use the fictional saved instrument. Connecting does not authorize a payment.', payload:{wallet:'sim_wallet_01',instrument:'Demo Visa ···· 4242',permission:'request_purchase',purchase_authority:false} },
  { kind:'request', from:'Atlas', to:'Seller agent', title:'Find headphones matching my buyer’s mission', detail:'The buyer permits catalog browsing: wireless headphones, 30+ hours of battery, delivery within two days, final total under $350.', payload:{request_id:'req_catalog_01',tool:'catalog.search',battery_min:30,delivery_days_max:2,budget_minor:35000,currency:'USD'} },
  { kind:'response', from:'Seller agent', to:'Atlas', title:'Seller catalog returned', detail:'Six products, with seller-owned price and inventory. Atlas compares the candidates using the stated requirements.', payload:{response_to:'req_catalog_01',catalog_version:1,product_count:6,source:'Northstar Audio'} },
  { kind:'request', from:'Atlas', to:'Seller agent', title:'Request a quote for Aurora Pro', detail:'Aurora meets the battery and delivery requirements at the lowest listed price among the matching in-stock products. Request a final seller quote before asking for consent.', payload:{request_id:'req_quote_01',product:'aurora-pro',quantity:1} },
  { kind:'response', from:'Seller agent', to:'Atlas', title:'Exact quote ready for buyer review', detail:'The seller returns the authoritative $303.19 fixture total. No payment has been submitted.', payload:{response_to:'req_quote_01',quote:'sim_quote_v1',subtotal_minor:quote.productMinor,discount_minor:quote.discountMinor,shipping_minor:quote.shippingMinor,tax_minor:quote.taxMinor,total_minor:quote.totalMinor,currency:'USD',stock_reserved:true} },
  { kind:'permission', from:'Buyer', to:'Wallet', title:'Buyer approved this exact purchase', detail:'Explicit approval for one Aurora Pro from Northstar Audio, $303.19 USD, using the demo instrument. The $350 shopping budget was not purchase consent.', payload:{approval:'sim_approval_01',quote:'sim_quote_v1',seller:'Northstar Audio',amount_minor:30319,currency:'USD',max_successful_purchases:1} },
  { kind:'response', from:'Wallet', to:'Atlas', title:'Scoped simulated SPT issued', detail:'A fictional opaque credential is bound to this buyer, seller and quote. It is not a Stripe-issued token and cannot be used for a real payment.', payload:{token_reference:'sim_spt_01',approval:'sim_approval_01',seller:'Northstar Audio',amount_minor:30319,currency:'USD',scope:'one approved purchase'} },
  { kind:'request', from:'Atlas', to:'Seller agent', title:'Complete the approved checkout', detail:'The seller backend revalidates authority, quote and stock, then fences a single payment operation. The agent never receives underlying card details.', payload:{request_id:'req_complete_01',quote:'sim_quote_v1',token_reference:'sim_spt_01',idempotency_key:'sim_purchase_01'} },
  { kind:'response', from:'Payment simulator', to:'Seller agent', title:'Payment response received', detail:'The simulator reports success. The order stays awaiting evidence until the callback is verified and recorded.', payload:{response_to:'req_complete_01',payment:'sim_payment_01',status:'succeeded',order:'awaiting_evidence'} },
  { kind:'evidence', from:'Payment simulator', to:'Seller backend', title:'Simulated callback verified and persisted', detail:'Trusted simulation evidence confirms the single order. This does not represent a Stripe transaction or a real webhook signature.', payload:{evidence:'sim_callback_01',payment:'sim_payment_01',verified_in_simulator:true,order:'confirmed'} },
  { kind:'response', from:'Seller agent', to:'Atlas', title:'Order confirmed. Receipt delivered.', detail:'Buyer and seller share one outcome: one pair of Aurora Pro headphones, $303.19, one simulated payment. Fulfillment is not performed.', payload:{order:'sim_order_01',product:'Aurora Pro Wireless',total_minor:30319,payment_count:1,mode:'simulation'} },
];
export const gates = { 0:'sign-in', 1:'connect-wallet', 2:'browse-catalog', 6:'approve-purchase' };
export function advanceSimulation(cursor, action='next') {
  if (!Number.isInteger(cursor) || cursor<0 || cursor>exchanges.length) throw new Error('Invalid simulation cursor');
  const gate=gates[cursor];
  if (gate && action!==gate) return cursor;
  return Math.min(cursor+1,exchanges.length);
}
export function projectionAt(cursor) {
  if (!Number.isInteger(cursor) || cursor<0 || cursor>exchanges.length) throw new Error('Invalid simulation cursor');
  return {signedIn:cursor>=1,walletConnected:cursor>=2,catalogVisible:cursor>=4,selected:cursor>=5,quoted:cursor>=6,approved:cursor>=7,tokenIssued:cursor>=8,submitted:cursor>=9,confirmed:cursor>=11,complete:cursor>=12,events:exchanges.slice(0,cursor)};
}
