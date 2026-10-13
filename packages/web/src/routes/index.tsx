import { createFileRoute } from "@tanstack/react-router";
import { useConfig } from "../config/config-context.tsx";

function Landing() {
  const { product } = useConfig();
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <h1 className="text-2xl font-semibold">{product.name}</h1>
    </main>
  );
}

export const Route = createFileRoute("/")({
  component: Landing,
});
