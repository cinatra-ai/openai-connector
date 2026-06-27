import * as React from "react"

import { cn } from "../../lib/utils"

// Anchor primitive for the shadcn link pattern (`<Button asChild><Link/></Button>`).
// This connector ships without a router, so the canonical link is a native
// `<a>`; vendoring it here keeps the raw anchor inside the exempt shadcn
// primitives directory while callers compose it with <Button asChild> for
// button-styled links. Styling/href/target all pass through unchanged.
function Link({ className, ...props }: React.ComponentProps<"a">) {
  return <a data-slot="link" className={cn(className)} {...props} />
}

export { Link }
