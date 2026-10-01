import "./styles.css";

export const metadata = {
  title: "PradPay Demo — Agent Interaction Studio",
  description: "Explore a local agent-to-agent commerce simulation with optional LM Studio and Stripe sandbox paths.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
