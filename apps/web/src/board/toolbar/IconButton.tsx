import type { ComponentProps } from "react";
import { Button } from "../upstream";

/** Foreman-style icon button: a ghost button with an accessible label and a native tooltip. */
export function IconButton({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label" | "title"> & { readonly label: string }) {
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} title={label} {...props}>
      {children}
    </Button>
  );
}
