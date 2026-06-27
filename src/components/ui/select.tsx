import * as React from "react"

import { cn } from "../../lib/utils"

// Native-`<select>` primitive. Kept as a real `<select>` (rather than the Radix
// listbox pattern) so it submits its chosen `<option>` inside a server-action
// `<form>` via FormData exactly like the raw element it replaces, and
// `defaultValue` keeps native uncontrolled semantics. Children are the standard
// `<option>` elements. Living in components/ui makes it the shadcn wrapper
// callers import instead of raw JSX; callers keep full styling control via
// `className` (merged with tailwind-merge).
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Select }
