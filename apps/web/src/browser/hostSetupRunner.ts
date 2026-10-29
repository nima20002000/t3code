import { createContext } from "react";

/**
 * Runs a host setup command (such as `sudo t3 browser setup`) in a terminal on the browser's own
 * machine, where the user can answer sudo. Without one, the command is shown to copy instead.
 */
export const HostSetupRunnerContext = createContext<((command: string) => void) | null>(null);
