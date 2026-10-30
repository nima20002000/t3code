import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { createContext } from "react";

/** What the composer is set to when `/new` moves the conversation to a fresh thread. */
export interface ComposerNewThreadSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Where the composer's `/new` command is offered: its handler starts a fresh thread with the
 * composer's settings and settles false if it could not. Without one, `/new` is not a command.
 */
export const ComposerNewThreadContext = createContext<
  ((settings: ComposerNewThreadSettings) => Promise<boolean>) | null
>(null);
