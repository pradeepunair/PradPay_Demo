import Link from "next/link";
import { notFound } from "next/navigation";

import LocalRunWorkspace from "../../components/local-run-workspace";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "PradPay — Local mission workspace",
  description: "A local development workspace for owned runs. No agents or payments are connected.",
};

export default function LocalRunPage() {
  if (process.env.PAYMENTLAB_RUN_API_MODE !== "local" || process.env.PAYMENTLAB_ENVIRONMENT !== "local"
    || process.env.PAYMENTLAB_DATABASE_MODE !== "local") notFound();
  return (
    <main>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="PradPay home">
          <span className="brand-mark">P</span>
          <span>PradPay</span>
        </Link>
        <span className="environment-pill">Local run · no agent or payment</span>
      </header>
      <LocalRunWorkspace />
    </main>
  );
}
