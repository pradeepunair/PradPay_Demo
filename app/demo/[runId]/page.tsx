import Link from "next/link";
import { notFound } from "next/navigation";

import ReplayWorkspace from "../../../components/replay-workspace";
import { listRecordings, loadRecording } from "../../../lib/replay/store.mjs";

export async function generateStaticParams() {
  const recordings = await listRecordings();
  return recordings.map((recording: { slug: string }) => ({ runId: recording.slug }));
}

export default async function ReplayPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const recording = await loadRecording(runId);
  if (!recording) notFound();

  return (
    <main className="replay-shell">
      <header className="site-header replay-site-header">
        <Link className="brand" href="/" aria-label="PradPay home">
          <span className="brand-mark">P</span>
          <span>PradPay</span>
        </Link>
        <span className="environment-pill">Guided Replay · no live calls</span>
      </header>
      <ReplayWorkspace recording={recording} />
    </main>
  );
}
