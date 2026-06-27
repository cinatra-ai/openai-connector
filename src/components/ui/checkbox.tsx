import * as React from "react"

import { cn } from "../../lib/utils"

// Native-input checkbox primitive. Kept as a real `<input type="checkbox">`
// (rather than the Radix button+hidden-input pattern) so it submits inside a
// server-action `<form>` via FormData exactly like the raw element it replaces,
// and `defaultChecked` keeps native uncontrolled semantics. Living in
// components/ui makes it the shadcn wrapper callers import instead of raw JSX.
// The base only adds focus/disabled affordances; callers keep full control of
// sizing/spacing via `className` (merged with tailwind-merge).
function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      data-slot="checkbox"
      className={cn(
        "accent-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
      type="checkbox"
    />
  )
}

export { Checkbox }
