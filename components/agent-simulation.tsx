'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { STUDIO_CATALOG, DEFAULT_STUDIO_MISSION, compareStudioCatalog, createAgentScenario,
  parseStudioMissionDraft, projectAgentScenario } from '../lib/replay/agent-simulation.mjs';
import { advanceScenarioCursor, nextScenarioAction } from '../lib/replay/agent-simulation-navigation.mjs';
import type { AgentFault, AgentScenarioEvent } from '../lib/replay/agent-simulation-contracts.mjs';
import type { StudioMission } from '../lib/replay/agent-simulation-commerce.mjs';
import { presentEventRoute, replayPhase, STUDIO_PARTICIPANTS } from '../lib/replay/agent-simulation-presentation.mjs';
import s from './agent-simulation.module.css';

const usd = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
const reasonLabels: Record<string, string> = {
  OUT_OF_STOCK: 'Out of stock', BATTERY_BELOW_MINIMUM: 'Battery below your minimum',
  DELIVERY_TOO_SLOW: 'Delivery exceeds your limit', OVER_BUDGET: 'Final total exceeds your budget',
  MERCHANT_DECLINED: 'Seller declined this quote',
};
const authorityReasons: Record<string, string> = {
  TOKEN_REVOKED: 'Buyer revoked the simulated token',
  TOKEN_EXPIRED: 'The simulated token expired',
  CHANGED_CART: 'Checkout amount differs from the approved quote',
  WRONG_RUN: 'Token belongs to a different run', WRONG_SELLER: 'Seller does not match token scope',
  WRONG_CURRENCY: 'Currency does not match token scope', QUOTE_CHANGED: 'Quote identity changed',
  TOKEN_MISMATCH: 'Token reference does not match', TOKEN_NOT_ISSUED: 'No issued token exists',
};
const scenarioOptions: { value: AgentFault; label: string }[] = [
  { value: 'none', label: 'Approved purchase' },
  { value: 'buyer_decline', label: 'Buyer declines' },
  { value: 'lost_response', label: 'Unknown outcome' },
  { value: 'lost_response_recovered', label: 'Unknown, then recovered' },
  { value: 'token_revoked', label: 'Buyer revokes token' },
  { value: 'token_expired', label: 'Token expires' },
  { value: 'changed_cart', label: 'Checkout amount changes' },
];
const phaseLabels = ['Buyer intent', 'Discovery', 'Seller quote', 'Consent', 'Payment', 'Outcome'];
const actionLabels: Record<string, string> = {
  'buyer.session_opened': 'Enter as demo buyer',
  'buyer.mission_established': 'Set this shopping mission',
  'buyer.wallet_connected': 'Connect simulated wallet',
  'buyer.browse_authorized': 'Allow catalog browsing',
  'buyer.product_selected': 'Confirm product for quote',
  'buyer.purchase_approved': 'Approve the exact seller quote',
  'buyer.purchase_declined': 'Decline the exact seller quote',
  'buyer.token_revoked': 'Revoke the simulated token',
};
const eventCopy: Record<string, [string, string]> = {
  'buyer.session_opened': ['Demo session opened', 'A fictional buyer entered Atlas. No account or password was collected.'],
  'buyer.mission_established': ['Shopping mission established', 'The buyer set product, battery, delivery and all-in budget requirements. This is not purchase consent.'],
  'buyer.wallet_connected': ['Fictional wallet connected', 'A simulated saved instrument is available. Connection does not authorize a payment.'],
  'buyer.browse_authorized': ['Buyer allowed catalog browsing', 'Atlas may ask the seller for product information. Payment authority remains absent.'],
  'agent.catalog_requested': ['Catalog requested', 'Atlas asks Northstar Audio for its seller-owned catalog.'],
  'seller.catalog_returned': ['Seller catalog returned', 'Northstar Audio reports six headphones for comparison.'],
  'buyer.product_selected': ['Buyer selected a headphone', 'The buyer chose one catalog item for a seller quote. Selection does not authorize payment.'],
  'agent.quote_requested': ['Exact quote requested', 'Atlas asks the seller to price the chosen headphone. Atlas supplies no price.'],
  'seller.quote_returned': ['Seller quote returned', 'The seller supplies the final total, including discount, shipping and illustrative tax.'],
  'seller.quote_refused': ['Seller refused the quote', 'A catalog or mission rule blocked the quote. No purchase authority or payment follows.'],
  'buyer.purchase_approved': ['Buyer approved this exact quote', 'Approval applies to one Northstar Audio purchase for the exact seller total.'],
  'buyer.purchase_declined': ['Buyer declined the purchase', 'The run ends before token issuance or payment submission.'],
  'agent.token_requested': ['Simulated token requested', 'Atlas asks the fictional wallet for a scoped teaching reference.'],
  'wallet.token_issued': ['Simulated token issued', 'The fictional wallet returns an opaque reference. This is not a Stripe token.'],
  'buyer.token_revoked': ['Buyer revoked token', 'The fictional wallet removes purchase authority before checkout.'],
  'simulation.clock_advanced': ['Simulation clock advanced', 'The teaching clock moves past the token expiry without waiting in real time.'],
  'agent.checkout_requested': ['Checkout requested', 'Atlas passes the quote and simulated token reference to the seller backend.'],
  'seller.checkout_denied': ['Checkout blocked before payment', 'The seller rejected the simulated token scope. No attempt or order was created.'],
  'seller.attempt_reserved': ['Attempt reserved', 'The seller records one simulated attempt and a pending order.'],
  'seller.payment_requested': ['Payment simulator called', 'The seller submits the reserved attempt to a local simulator only.'],
  'provider.response_received': ['Simulator response received', 'The simulated provider reports a result; the order still waits for callback evidence.'],
  'provider.response_lost': ['Simulator response lost', 'The original attempt is uncertain. A new purchase is not created.'],
  'provider.callback_verified': ['Simulated callback recorded', 'Trusted simulation evidence is now visible to the reducer. No real webhook was received.'],
  'seller.order_confirmed': ['Order confirmed in simulation', 'The seller confirms one fictional order after the simulated callback.'],
};
const description = (event: AgentScenarioEvent): [string, string] => {
  const [title, detail] = eventCopy[event.type] ?? [event.type, 'Safe simulation event.'];
  if (event.type === 'seller.quote_returned') return [title, `${detail} Exact total: ${usd(event.safePayload.totalMinor as number)}.`];
  if (event.type === 'seller.quote_refused') return [title, `${reasonLabels[String(event.safePayload.reason)] ?? 'Quote refused'}. No payment was submitted.`];
  if (event.type === 'seller.checkout_denied') return [title, `${authorityReasons[String(event.safePayload.reason)] ?? 'Authority denied'}. No payment was submitted.`];
  if (event.type === 'buyer.product_selected' || event.type === 'agent.quote_requested') {
    const name = STUDIO_CATALOG.find(item => item.id === event.safePayload.productId)?.name ?? 'the item';
    return [title, `${detail} Product: ${name}.`];
  }
  return [title, detail];
};

function Headphones({ small = false }: { small?: boolean }) {
  return <svg className={small ? s.smallPhones : s.phones} viewBox="0 0 180 160" fill="none" aria-hidden="true"><path d="M38 93V76a52 52 0 0 1 104 0v17" stroke="currentColor" strokeWidth="14" strokeLinecap="round"/><path d="M47 78V65a43 43 0 0 1 86 0v13" stroke="currentColor" opacity=".28" strokeWidth="5"/><rect x="26" y="78" width="32" height="59" rx="14" fill="currentColor"/><rect x="122" y="78" width="32" height="59" rx="14" fill="currentColor"/><path d="M142 132c0 13-18 20-41 20" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/><rect x="85" y="146" width="24" height="9" rx="4" fill="currentColor"/></svg>;
}

export default function AgentSimulation() {
  const [modelBusy, setModelBusy] = useState(false);
  const [modelResult, setModelResult] = useState<{ productId: string; model: string } | null>(null);
  const [modelError, setModelError] = useState('');
  const modelRequest = useRef(0);
  const [branch, setBranch] = useState<AgentFault>('none');
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inspect, setInspect] = useState<number | null>(null);
  const [motion, setMotion] = useState(true);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [narration, setNarration] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [furthestCursor, setFurthestCursor] = useState(0);
  const [mission, setMission] = useState<StudioMission>(DEFAULT_STUDIO_MISSION);
  const [missionDraft, setMissionDraft] = useState({ batteryHoursMin: '30', deliveryDaysMax: '2', maxTotalDollars: '350' });
  const [missionError, setMissionError] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('aurora-pro');
  const scenario = useMemo(() => createAgentScenario({ mission, selectedProductId,
    fault: branch }), [mission, selectedProductId, branch]);
  const p = projectAgentScenario(scenario, cursor);
  const required = nextScenarioAction(scenario, cursor);
  const finished = cursor === scenario.events.length;
  const last = p.visibleEvents.at(-1);
  const route = presentEventRoute(last);
  const phaseIndex = replayPhase(last);
  const animateRoute = motion && !systemReducedMotion;
  const active = p.visibleEvents[inspect ?? cursor - 1];
  const sessionOpen = p.session === 'open';
  const walletConnected = p.wallet === 'connected';
  const comparison = p.discovery === 'returned' ? compareStudioCatalog(mission) : null;
  const selectedProduct = STUDIO_CATALOG.find(item => item.id === (p.selectedProductId ?? selectedProductId));
  const recommendedProduct = STUDIO_CATALOG.find(item => item.id === comparison?.recommendedProductId);
  const quoteRequested = p.checkout !== 'none';
  const approved = p.approval === 'granted';
  const tokenExpired = !!p.tokenScope && !!p.clockAt && Date.parse(p.clockAt) >= Date.parse(String(p.tokenScope.expiresAt));
  const authorityBlocked = p.checkout === 'blocked';
  const submitted = !['none', 'reserved'].includes(p.attempt);
  const complete = p.order === 'confirmed';
  const declined = p.approval === 'declined';
  const phase = authorityBlocked ? 'Checkout blocked' : p.checkout === 'refused' ? 'Quote refused' : declined ? 'Purchase declined' : complete ? 'Journey complete' : p.attempt === 'unknown' ? 'Outcome unknown' :
    required === 'buyer.purchase_approved' ? 'Waiting for buyer consent' : p.quote ? 'Quote & permission' :
    p.discovery !== 'not_requested' ? 'Discovery & quote' : walletConnected ? 'Mission & browsing' : sessionOpen ? 'Buyer setup' : 'Ready when you are';

  function step(action = 'next') {
    setInspect(null);
    setCursor(current => advanceScenarioCursor(scenario, current, action));
  }
  function seek(next: number) {
    modelRequest.current++;
    setModelBusy(false);
    setModelResult(null);
    setPlaying(false);
    setInspect(null);
    setCursor(next);
  }
  function selectScenario(fault: AgentFault) {
    modelRequest.current++;
    setModelBusy(false);
    setPlaying(false);
    setInspect(null);
    setBranch(fault);
    setModelResult(null);
    setModelError('');
    setCursor(0);
    setFurthestCursor(0);
  }
  function chooseApprove() {
    setPlaying(false);
    setInspect(null);
    if (branch !== 'buyer_decline') {
      step('buyer.purchase_approved');
      return;
    }
    const approvedScenario = createAgentScenario({ mission, selectedProductId, fault: 'none' });
    setBranch('none');
    const next = advanceScenarioCursor(approvedScenario, cursor, 'buyer.purchase_approved');
    setCursor(next);
    setFurthestCursor(next);
  }
  function chooseDecline() {
    setPlaying(false);
    setInspect(null);
    const declinedScenario = createAgentScenario({ mission, selectedProductId, fault: 'buyer_decline' });
    setBranch('buyer_decline');
    const next = advanceScenarioCursor(declinedScenario, cursor, 'buyer.purchase_declined');
    setCursor(next);
    setFurthestCursor(next);
  }
  function commitMission() {
    try {
      const terms = parseStudioMissionDraft(missionDraft);
      setMission(terms);
      modelRequest.current++;
      setModelBusy(false);
      setModelResult(null);
      setModelError('');
      setSelectedProductId(compareStudioCatalog(terms).recommendedProductId ?? 'aurora-pro');
      setMissionError('');
      setInspect(null);
      setCursor(2);
      setFurthestCursor(2);
    } catch {
      setMissionError('Enter battery hours from 1–200, delivery days from 1–30, and a USD budget from $1–$10,000.');
    }
  }
  useEffect(() => {
    if (!playing) return;
    if (required || finished) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setCursor(current => advanceScenarioCursor(scenario, current)), 1400 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, cursor, required, finished, scenario, speed]);
  useEffect(() => { setFurthestCursor(previous => Math.max(previous, cursor)); }, [cursor]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReducedMotion(preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!narration || !last || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const [title, detail] = description(last);
    const utterance = new SpeechSynthesisUtterance(`${title}. ${detail}`);
    utterance.rate = speed === 2 ? 1.4 : speed === .5 ? .85 : 1;
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [narration, last?.eventId, speed]);
  async function suggestWithLocalModel() {
    if (modelBusy || required !== 'buyer.product_selected') return;
    const requestId = ++modelRequest.current;
    setModelBusy(true);
    setModelError('');
    setModelResult(null);
    try {
      const response = await fetch('/api/studio/local-selection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        cache: 'no-store', body: JSON.stringify({ mission }),
      });
      const data = await response.json();
      if (requestId !== modelRequest.current) return;
      if (!response.ok) throw new Error(data.error ?? 'LOCAL_MODEL_UNAVAILABLE');
      if (!comparison?.comparisons.some(item => item.productId === data.productId && item.eligible)) {
        throw new Error('LOCAL_SELECTION_INVALID');
      }
      setSelectedProductId(data.productId);
      setModelResult({ productId: data.productId, model: data.model });
    } catch (error) {
      if (requestId === modelRequest.current) setModelError(error instanceof Error ? error.message : 'LOCAL_MODEL_UNAVAILABLE');
    } finally { if (requestId === modelRequest.current) setModelBusy(false); }
  }

  const stageRoute = last ? `${last.actor} → ${last.recipient}` : 'Buyer → Atlas';
  const routeStyle = { '--route-from': `${route.from}%`, '--route-to': `${route.to}%`,
    '--route-duration': `${Math.round(1050 / speed)}ms` } as CSSProperties;
  return <main className={`${s.studio} ${!animateRoute ? s.still : ''}`}>
    <header className={s.topbar}>
      <Link href="/" className={s.brand}><span className={s.logo}>P</span>PradPay<span className={s.divider}>/</span><span className={s.studioLabel}>Interaction studio</span></Link>
      <label className={s.motionToggle}><input type="checkbox" checked={motion} onChange={event => setMotion(event.target.checked)}/>Animation</label>
      <span className={s.mode}><i/>LOCAL SIMULATION</span>
      <Link href="/demo/synthetic-success-v1" className={s.replayLink}>Classic replay ↗</Link>
    </header>
    <section className={s.intro}><div><p className={s.eyebrow}>TWO AGENTS. ONE BUYER-APPROVED PURCHASE.</p><h1>A conversation that<br/>becomes a checkout.</h1><p className={s.subtitle}>Follow the buyer’s mission, seller quote and every permission through one shared event cursor.</p></div><div className={s.runCard}><span className={s.runLabel}>HEADPHONE SHOPPING · {scenario.runId}</span><strong>{phase}</strong><div className={s.progress}><span style={{ width: `${cursor / scenario.events.length * 100}%` }}/></div><small>{cursor} of {scenario.events.length} events · no real accounts or money</small><label className={s.scenarioPicker}>Teaching scenario<select value={branch} onChange={event => selectScenario(event.target.value as AgentFault)}>{scenarioOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><div className={s.runControls}><div className={s.controls}><button className={s.secondary} disabled={!cursor} onClick={() => seek(cursor - 1)} aria-label="Previous event">← Back</button><button className={s.secondary} disabled={!!required || finished} onClick={() => setPlaying(!playing)}>{playing ? 'Pause' : 'Auto-play'}</button><button className={s.primary} disabled={!!required || finished} onClick={() => { setPlaying(false); step(); }}>Next exchange →</button><button className={s.reset} onClick={() => seek(0)}>Restart</button><label className={s.speedControl}>Speed<select aria-label="Playback speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label><label className={s.voiceControl}><input type="checkbox" checked={narration} onChange={event => setNarration(event.target.checked)}/>Read captions aloud</label></div></div></div></section>
    <div className={s.safety}>Scripted replay · fictional wallet and callback · optional local model suggestion is separate · no Stripe calls.</div>
    <nav className={s.mobileNav} aria-label="Studio sections"><a href="#buyer-pane">Buyer</a><a href="#seller-pane">Seller</a><a href="#timeline-title">Timeline</a><Link href="/demo/synthetic-success-v1">Classic replay</Link></nav>
    <ol className={s.phaseRail} aria-label="Replay phases">{phaseLabels.map((label, index) => <li key={label} className={`${index === phaseIndex ? s.currentPhase : ''} ${index < phaseIndex ? s.pastPhase : ''}`} aria-current={index === phaseIndex ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span>{label}</li>)}</ol>
    <section className={s.routeStage} aria-label="Current agent exchange">
      <div className={s.routeHeader}><span className={s.overline}>NOW SHOWING · {phaseLabels[phaseIndex]}</span><strong>{last ? stageRoute : 'A buyer instruction starts the conversation'}</strong><span className={s.routeCounter}>{String(cursor).padStart(2, '0')} / {String(scenario.events.length).padStart(2, '0')}</span></div>
      <div className={s.routeViewport}><div className={s.routeTrack} style={routeStyle}>
        <div className={s.routeLine}/>
        {route.kind === 'message' && <span key={`${last?.eventId}-${animateRoute}`} className={`${s.routePacket} ${animateRoute ? s.routePacketMoving : s.routePacketStill}`} aria-hidden="true"/>}
        {route.kind === 'system' && <span className={s.systemEvent}>Simulation event · no message sent</span>}
        {STUDIO_PARTICIPANTS.map((participant, index) => <div key={participant.id} className={`${s.routeParticipant} ${route.sender === participant.id ? s.routeSender : ''} ${route.receiver === participant.id ? s.routeReceiver : ''}`} style={{ left: `${index * 20}%` }}><span className={s.routeAvatar}>{participant.id === 'Payment simulator' ? 'P' : participant.id === 'Seller backend' ? 'S' : participant.id === 'Seller agent' ? 'N' : participant.id === 'Wallet' ? 'W' : participant.id === 'Atlas' ? 'A' : 'B'}</span><span>{participant.label}</span></div>)}
      </div></div>
      <div className={s.routeNarration} aria-live="polite"><span>{required ? `PAUSED FOR BUYER · ${actionLabels[required]}` : route.kind === 'system' ? 'SYSTEM EVENT' : route.kind === 'message' ? `${last?.eventClass.replace('_', ' ').toUpperCase()} · ${stageRoute}` : 'READY TO BEGIN'}</span><h2>{last ? description(last)[0] : 'Your instruction starts the conversation'}</h2><p>{last ? description(last)[1] : 'Open a fictional session to begin.'}</p></div>
    </section>
    <section className={s.dual} aria-label="Buyer and seller split screen">
      <article id="buyer-pane" className={`${s.panel} ${s.buyer} ${last?.recipient === 'Atlas' ? s.activePanel : ''}`}><div className={s.panelTop}><span className={s.sideNumber}>01</span><div><span className={s.overline}>BUYER EXPERIENCE</span><h2>You & Atlas</h2></div><span className={s.statusDot}>{sessionOpen ? 'Demo session open' : 'Not connected'}</span></div>
        <div className={s.identity}><span className={s.avatar}>A<span>✦</span></span><div><strong>Atlas</strong><p>Your fictional shopping agent</p></div><span className={s.agentTag}>BUYER AGENT</span></div>
        {!sessionOpen ? <div className={s.welcome}><span className={s.spark}>✦</span><h3>Your next purchase,<br/>with you in control.</h3><p>Enter a fictional buyer session. Atlas will request your approval before any simulated purchase.</p><button className={s.primary} onClick={() => step('buyer.session_opened')}>Enter as demo buyer →</button><small>No email, password or real login.</small></div> : <>
          <div className={s.wallet}><div className={s.walletIcon}>▣</div><div><strong>Link-style demo wallet</strong><p>{p.token === 'revoked' ? 'Simulated token revoked · no payment authority' : tokenExpired && p.token === 'issued' ? 'Simulated token expired · no payment authority' : p.token === 'presented' ? 'One-use token presented to seller · payment outcome separate' : walletConnected ? 'Fictional saved instrument · purchase approval required' : 'Not connected · no payment authority'}</p></div><span className={walletConnected ? s.connected : s.unconnected}>{p.token === 'revoked' ? 'Revoked' : tokenExpired && p.token === 'issued' ? 'Expired' : p.token === 'presented' ? 'Presented' : walletConnected ? 'Connected' : 'Offline'}</span></div>
          {required === 'buyer.mission_established' ? <div className={s.missionEditor}><span className={s.overline}>YOU · SHOPPING MISSION</span><h3>Tell Atlas what to find</h3><p>Wireless headphones from Northstar Audio. Ask before buying.</p><div className={s.missionFields}><label>Minimum battery hours<input type="number" min="1" max="200" value={missionDraft.batteryHoursMin} onChange={event => setMissionDraft({ ...missionDraft, batteryHoursMin: event.target.value })}/></label><label>Maximum delivery days<input type="number" min="1" max="30" value={missionDraft.deliveryDaysMax} onChange={event => setMissionDraft({ ...missionDraft, deliveryDaysMax: event.target.value })}/></label><label>Maximum final total (USD)<input type="number" min="1" max="10000" step="0.01" value={missionDraft.maxTotalDollars} onChange={event => setMissionDraft({ ...missionDraft, maxTotalDollars: event.target.value })}/></label></div>{missionError && <p className={s.formError} role="alert">{missionError}</p>}<button className={s.primary} onClick={commitMission}>Set this shopping mission →</button><small>These constraints permit browsing only. They do not approve a purchase.</small></div> : <div className={s.bubbleUser}><span>YOU · SHOPPING MISSION</span><p>Find wireless headphones with {p.missionTerms?.batteryHoursMin as number}+ hours of battery and delivery within {p.missionTerms?.deliveryDaysMax as number} days. Keep the final total under <strong>{usd(p.missionTerms?.maxTotalMinor as number)}</strong>. Ask me before buying.</p><small>Mission recorded · not purchase consent</small></div>}
          {required === 'buyer.wallet_connected' && <button className={s.primary} onClick={() => step(required)}>Connect simulated wallet →</button>}
          {required === 'buyer.browse_authorized' && <button className={s.primary} onClick={() => step(required)}>Allow catalog browsing →</button>}
          {p.browsing === 'authorized' && <div className={s.bubbleAgent}><span>✦ ATLAS</span><p>{p.discovery === 'not_requested' ? 'I can now ask Northstar Audio for its catalog.' : p.discovery === 'requested' ? 'I asked the seller for its catalog. I will compare stock, battery, delivery and all-in cost.' : recommendedProduct ? `${recommendedProduct.name} is the lowest-total item meeting your mission. You may choose another headphone for a seller quote.` : 'No catalog item meets every constraint. Review each reason or change your mission.'}</p></div>}
          {comparison && <section className={s.comparison} aria-labelledby="comparison-title"><span className={s.overline}>SELLER CATALOG · BUYER COMPARISON</span><h3 id="comparison-title">Compare all six headphones</h3><p>Estimates include the seller’s fixed demo offer, shipping and illustrative tax. Only a returned seller quote is final.</p><div className={s.comparisonList}>{comparison.comparisons.map(item => <label key={item.productId} className={`${s.comparisonItem} ${selectedProductId === item.productId ? s.comparisonSelected : ''}`}><input type="radio" name="studio-product" value={item.productId} checked={selectedProductId === item.productId} disabled={required !== 'buyer.product_selected'} onChange={() => { setSelectedProductId(item.productId); setModelResult(null); }}/><span><strong>{item.productName}</strong><small>{item.batteryHours} h battery · {item.deliveryDays}-day delivery · {item.stock ? `${item.stock} in stock` : 'sold out'}</small><small>Item {usd(item.productMinor)} · estimated final {usd(item.totalMinor)}</small><em>{item.eligible ? item.productId === comparison.recommendedProductId ? 'Best eligible total' : 'Meets mission' : item.reasons.map(reason => reasonLabels[reason]).join(' · ')}</em></span></label>)}</div>{required === 'buyer.product_selected' && <div className={s.modelSuggestion}><button className={s.secondary} disabled={modelBusy} onClick={suggestWithLocalModel}>{modelBusy ? 'Asking local model…' : 'Suggest with local Buyer model'}</button><small>Optional LM Studio suggestion. The buyer still chooses a product and approves the exact quote. It does not alter the replay evidence or call Stripe.</small>{modelResult && <p role="status">Local model {modelResult.model} suggested {STUDIO_CATALOG.find(item => item.id === modelResult.productId)?.name}. Review the selection, then choose it for a seller quote.</p>}{modelError && <p className={s.formError} role="alert">{modelError === 'LOCAL_SELECTION_DISABLED' ? 'Local model selection is off. Enable it for a loopback-only session, then restart the app.' : `Local model suggestion unavailable (${modelError}). You can choose manually.`}</p>}</div>}{required === 'buyer.product_selected' && <button className={s.primary} disabled={modelBusy} onClick={() => step('buyer.product_selected')}>Choose {selectedProduct?.name} for seller quote →</button>}</section>}
          {p.selectedProductId && selectedProduct && <div className={s.recommendation}><div className={s.productArt}><Headphones/></div><div><span className={s.overline}>BUYER SELECTION</span><h3>{selectedProduct.name}</h3><p>{selectedProduct.batteryHours} h battery · {selectedProduct.deliveryDays}-day delivery</p><strong>{p.quote ? `${usd(p.quote.totalMinor as number)} final total` : `${usd(selectedProduct.priceMinor)} item price`}</strong><small>{p.checkout === 'refused' ? 'Seller refused this quote' : p.quote ? 'Final seller quote returned below' : quoteRequested ? 'Waiting for final seller quote' : 'Seller quote not requested yet'}</small></div></div>}
          {p.checkout === 'refused' && <div className={s.consent}><span className={s.overline}>SELLER REFUSAL</span><h3>Quote unavailable</h3><p>{comparison?.comparisons.find(item => item.productId === p.selectedProductId)?.reasons.map(reason => reasonLabels[reason]).join(' · ') || reasonLabels[String(last?.safePayload.reason)] || 'The seller declined this quote.'} No approval, token or payment was created.</p><button className={s.secondary} onClick={() => seek(6)}>Choose another headphone</button></div>}
          {p.quote && <div className={s.quoteBreakdown}><span className={s.overline}>SELLER-PRICED QUOTE · {String(p.quote.quoteId)}</span><h3>{selectedProduct?.name}</h3><dl><div><dt>Item price</dt><dd>{usd(p.quote.productMinor as number)}</dd></div><div><dt>Demo offer</dt><dd>−{usd(p.quote.discountMinor as number)}</dd></div><div><dt>Shipping</dt><dd>{usd(p.quote.shippingMinor as number)}</dd></div><div><dt>Illustrative tax</dt><dd>{usd(p.quote.taxMinor as number)}</dd></div><div className={s.quoteTotal}><dt>Exact final total</dt><dd>{usd(p.quote.totalMinor as number)}</dd></div></dl><small>Stock reservation: simulated only · {String(p.reservationReference)}. No inventory was changed.</small></div>}
          {p.quote && p.approval === 'pending' && <div className={s.consent}><span className={s.overline}>YOUR PERMISSION IS REQUIRED</span><h3>Approve this exact purchase?</h3><p>One {selectedProduct?.name} · Northstar Audio · {usd(p.quote.totalMinor as number)} USD<br/>Fictional wallet · quote {String(p.quote.quoteId)}</p><p className={s.consentNote}>Your wallet connection and {usd(mission.maxTotalMinor)} shopping budget did not authorize this payment.</p><div className={s.consentActions}><button className={s.primary} onClick={chooseApprove}>Approve {usd(p.quote.totalMinor as number)}</button><button className={s.secondary} onClick={chooseDecline}>Decline</button></div></div>}
          {declined && <div className={s.consent}><h3>Purchase declined</h3><p>No token or payment attempt was created.</p><button className={s.secondary} onClick={() => seek(9)}>Review quote again</button></div>}
          {approved && <div className={s.approved}>✓ You approved one {usd(p.quote?.totalMinor as number)} purchase.{p.tokenScope && <small>Fictional token scoped to this run, seller, quote, amount and expiry.</small>}</div>}
          {required === 'buyer.token_revoked' && <div className={s.consent}><span className={s.overline}>BUYER WALLET CONTROL</span><h3>Revoke this simulated token?</h3><p>Checkout will be denied before an attempt is reserved.</p><button className={s.secondary} onClick={() => step('buyer.token_revoked')}>Revoke token →</button></div>}
          {authorityBlocked && <div className={s.consent} role="status"><span className={s.overline}>AUTHORITY CHECK FAILED</span><h3>Checkout stopped before payment</h3><p>{authorityReasons[p.checkoutDeniedReason ?? ''] ?? 'Token scope did not match.'} No attempt, order or payment was created.</p></div>}
          {complete && <div className={s.receipt}><span>✓ ORDER CONFIRMED IN SIMULATION</span><h3>Your headphones are on the receipt.</h3><p>{p.orderId} · {selectedProduct?.name} · {usd(p.quote?.totalMinor as number)} · one simulated payment</p><small>Demonstration only. No real charge or fulfillment.</small></div>}
        </>}
      </article>
      <article id="seller-pane" className={`${s.panel} ${s.seller} ${last?.recipient?.startsWith('Seller') ? s.activePanel : ''}`}><div className={s.panelTop}><span className={s.sideNumber}>02</span><div><span className={s.overline}>SELLER EXPERIENCE</span><h2>Northstar Audio</h2></div><span className={s.statusDot}>Catalog ready</span></div><div className={s.identity}><span className={`${s.avatar} ${s.sellerAvatar}`}>N<span>✦</span></span><div><strong>Northstar assistant</strong><p>Catalog & checkout coordination</p></div><span className={s.agentTag}>SELLER AGENT</span></div>
        <div className={s.catalogHeader}><h3>Headphone collection</h3><span>6 products · catalog v1</span></div><div className={s.catalog}>{STUDIO_CATALOG.map(item => <div className={`${s.catalogItem} ${p.quote?.productId === item.id ? s.selectedProduct : ''}`} key={item.id}><div className={s.miniArt}><Headphones small/></div><div><strong>{item.name}</strong><small>{item.batteryHours} h · {item.deliveryDays}-day delivery</small><span>{usd(item.priceMinor)} <em>{item.stock ? 'In stock' : 'Sold out'}</em></span></div>{p.quote?.productId === item.id && <span className={s.chosen}>✓</span>}</div>)}</div>
        <div className={s.sellerMessage}><span className={s.overline}>LATEST VISIBLE EVENT</span>{last ? <><p><strong>{stageRoute}</strong></p><p>{description(last)[0]}</p><small>{description(last)[1]}</small></> : <p className={s.waiting}>Waiting for a buyer agent…<br/><small>Requests appear as the shared cursor advances.</small></p>}</div>
        <div className={s.commerceStatus}><div><span>Checkout</span><strong>{p.order === 'confirmed' ? 'Confirmed' : authorityBlocked ? 'Blocked' : p.order === 'pending_payment' ? 'Pending evidence' : p.checkout === 'refused' ? 'Refused' : p.quote ? 'Quoted' : p.checkout === 'quote_requested' ? 'Quote requested' : 'Not started'}</strong></div><div><span>Authority</span><strong>{p.token === 'revoked' ? 'Token revoked' : tokenExpired ? 'Token expired' : authorityBlocked ? 'Scope rejected' : declined ? 'Declined' : approved ? 'Exact purchase approved' : 'Not granted'}</strong></div><div><span>Payment</span><strong>{complete ? 'Simulated success' : p.attempt === 'unknown' ? 'Unknown' : submitted ? 'Submitted' : 'Not submitted'}</strong></div></div>
        {p.reservation === 'simulated' && <p className={s.reservationNote}>Simulated stock reservation: {p.reservationReference}. Seller inventory is unchanged.</p>}
        {p.tokenScope && <div className={s.token}><span className={s.overline}>SIMULATED SHARED PAYMENT TOKEN · {p.token === 'revoked' ? 'REVOKED' : p.token === 'presented' ? 'PRESENTED' : tokenExpired ? 'EXPIRED' : 'ISSUED'}</span><code>{p.tokenReference}</code><p>Northstar Audio · {usd(p.quote?.totalMinor as number)} USD · one approved purchase</p><small>Run {String(p.tokenScope.runId)} · quote v{String(p.tokenScope.quoteVersion)} / {String(p.tokenScope.quoteHash)} · expires {String(p.tokenScope.expiresAt)}</small><small>Opaque teaching reference. Not issued by Stripe.</small></div>}
      </article>
    </section>
    <section className={s.timeline} aria-labelledby="timeline-title"><div className={s.timelineHeader}><div><p className={s.eyebrow}>THE SHARED EVIDENCE TRAIL</p><h2 id="timeline-title">Every exchange, in sequence.</h2></div></div>
      <p className={s.controlHint} aria-live="polite">{required ? `Buyer action needed: ${actionLabels[required]}.` : finished ? 'Run complete. Inspect an event, step back or restart.' : 'Advance one event at a time. Auto-play pauses before every buyer action.'}</p>
      <div className={s.seekControl}><label htmlFor="studio-replay-seek">Replay position</label><input id="studio-replay-seek" type="range" min="0" max={Math.max(0, furthestCursor)} value={cursor} disabled={!furthestCursor} onChange={event => seek(Number(event.target.value))} aria-valuetext={`Event ${cursor} of ${scenario.events.length}`}/><output htmlFor="studio-replay-seek">{cursor} / {scenario.events.length}</output><small>Scrub only through events already reached in this scenario.</small></div>
      <div className={s.traceLayout}><div className={s.trace}>{p.visibleEvents.length === 0 ? <div className={s.emptyTrace}>Your first event appears when you enter the demo session.</div> : p.visibleEvents.map((event, index) => <button key={event.eventId} className={`${s.traceRow} ${(inspect ?? cursor - 1) === index ? s.activeEvent : ''}`} aria-pressed={(inspect ?? cursor - 1) === index} onClick={() => setInspect(index)}><span className={s.sequence}>{String(event.sequence).padStart(2, '0')}</span><span className={`${s.kind} ${event.eventClass === 'agent_request' || event.eventClass === 'provider_request' ? s.request : event.eventClass === 'buyer_action' ? s.permission : event.eventClass === 'provider_evidence' ? s.evidence : ''}`}>{event.eventClass.replace('_', ' ')}</span><span className={s.traceText}><strong>{event.actor} <span>→</span> {event.recipient}</strong><small>{description(event)[0]}</small></span><span aria-hidden="true">↗</span></button>)}</div><aside className={s.inspector}><span className={s.overline}>EXCHANGE INSPECTOR</span>{active ? <><h3>{description(active)[0]}</h3><p>{description(active)[1]}</p><dl className={s.eventMeta}><div><dt>Class</dt><dd>{active.eventClass}</dd></div><div><dt>Request</dt><dd>{active.requestId ?? active.responseTo ?? '—'}</dd></div><div><dt>Cause</dt><dd>{active.causeEventId ?? '—'}</dd></div></dl><pre>{JSON.stringify(active.safePayload, null, 2)}</pre></> : <p>Only visible, allowlisted simulation payloads appear here. No credentials.</p>}</aside></div>
    </section><footer className={s.footer}>PradPay / interaction studio <span>Scripted agents · fictional wallet · simulated SPT · no stablecoins</span></footer>
  </main>;
}
