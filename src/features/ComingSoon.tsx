import { Construction } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "../components/primitives/EmptyState";

/** Proper empty state for IA sections not yet built. Never a blank screen. */
export function ComingSoon({ title, description }: { title: string; description: ReactNode }) {
  return <EmptyState icon={<Construction size={28} />} title={title} subline={description} />;
}
