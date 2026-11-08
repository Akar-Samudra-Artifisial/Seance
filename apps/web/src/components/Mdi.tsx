import type { ReactNode } from "react";

/**
 * MDI area: holds the one Maximised_Child. Starts 2 px below the toolbar (R1.1). `relative` so the
 * Compact nick overlay can sit inside it.
 */
export function Mdi(props: { readonly children?: ReactNode }): ReactNode {
  return <main className="relative mt-0.5 flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</main>;
}
