import type { ReactNode } from "react";

/** MDI area: a CSS grid whose single cell holds the expanded Active_Window. */
export function Mdi(props: { readonly children?: ReactNode }): ReactNode {
  return <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 gap-1 p-1">{props.children}</main>;
}
