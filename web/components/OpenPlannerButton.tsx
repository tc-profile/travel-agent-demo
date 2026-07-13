"use client";

import type { ReactNode } from "react";
import { OPEN_CHAT_EVENT } from "./chatWidgetEvents";

export default function OpenPlannerButton({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_CHAT_EVENT))}
      className={className}
    >
      {children}
    </button>
  );
}
