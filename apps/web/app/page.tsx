import { ClientApp } from "../src/components/ClientApp";
import { computeConnectConfig } from "../src/config/connect-src";

export default function Page() {
  const { defaultUrl, allowedOrigins } = computeConnectConfig(process.env);
  return <ClientApp defaultUrl={defaultUrl} allowedOrigins={allowedOrigins} />;
}
