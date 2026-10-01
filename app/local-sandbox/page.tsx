import Link from "next/link";
import { notFound } from "next/navigation";
import LocalSandboxJourney from "../../components/local-sandbox-journey";
import FailureRecoveryDemo from "../../components/failure-recovery-demo";
import { localJourneyConfiguration } from "../../lib/demo/local-journey.mjs";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "PradPay — Local A2A sandbox",
  description: "Inspect a local agent-to-agent purchase and a separately approved Stripe sandbox payment.",
};
export default function LocalSandboxPage() {
  const config = localJourneyConfiguration();
  if (!config) notFound();
  return <main>
    <header className="site-header">
      <Link className="brand" href="/" aria-label="PradPay home"><span className="brand-mark">P</span><span>PradPay</span></Link>
      <span className="environment-pill">{config.store === "postgres" ? "Local demo · saved across restarts" : "Local only · Stripe sandbox"}</span>
    </header>
    <LocalSandboxJourney paymentEnabled={config.paymentEnabled} scenarioEnabled={config.store === "postgres"} />
    {config.store === "postgres" && <FailureRecoveryDemo />}
  </main>;
}
