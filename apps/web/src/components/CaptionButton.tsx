import type { ReactNode } from "react";
import {
  BtnClose,
  BtnClosePressed,
  BtnMax,
  BtnMaxPressed,
  BtnMin,
  BtnMinPressed,
  BtnRestore,
  BtnRestorePressed,
} from "../icons/index.js";
import type { IconProps } from "../icons/index.js";

export type CaptionKind = "min" | "max" | "restore" | "close";

type IconComponent = (props: IconProps) => ReactNode;

const ICONS: Readonly<Record<CaptionKind, readonly [IconComponent, IconComponent]>> = {
  min: [BtnMin, BtnMinPressed],
  max: [BtnMax, BtnMaxPressed],
  restore: [BtnRestore, BtnRestorePressed],
  close: [BtnClose, BtnClosePressed],
};

const iconClass = "block h-[14px] w-4";

/**
 * A 16x14 caption button drawn by the Figma button icons (they carry their own bevel). While the
 * button is held down, the pressed drawing replaces the raised one. A disabled button keeps the
 * raised drawing; `aria-disabled` (inert, still focusable) and native `disabled` are both supported.
 */
export function CaptionButton(props: {
  readonly kind: CaptionKind;
  readonly label: string;
  readonly title?: string | undefined;
  /** Why the button is disabled or inert; also the tooltip when no `title` is given. */
  readonly description?: string | undefined;
  /** Native disabled: not focusable (used where the old button was `disabled`). */
  readonly disabled?: boolean | undefined;
  /** `aria-disabled`: focusable but inert. */
  readonly inert?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const [Raised, Pressed] = ICONS[props.kind];
  const live = props.disabled !== true && props.inert !== true;
  return (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-description is a global ARIA 1.3 attribute that the plugin does not know yet
    <button
      type="button"
      aria-label={props.label}
      title={props.title ?? props.description}
      aria-description={props.description}
      disabled={props.disabled === true ? true : undefined}
      aria-disabled={props.inert === true ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (live) props.onClick?.();
      }}
      className={`hit-target group block h-[14px] w-4 shrink-0 disabled:opacity-60 ${props.className ?? ""}`}
    >
      <Raised className={live ? `${iconClass} group-active:hidden` : iconClass} />
      {live ? <Pressed className={`${iconClass} hidden group-active:block`} /> : null}
    </button>
  );
}
