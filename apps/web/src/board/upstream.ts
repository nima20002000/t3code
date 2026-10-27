// The board's only door into t3's web app: every upstream module board code uses is re-exported here,
// so an upstream merge that breaks the board breaks this file. scripts/fork-boundary.mjs enforces it.
export { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
export { default as ChatView } from "../components/ChatView";
export { Button } from "../components/ui/button";
export {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
export { Input } from "../components/ui/input";
export {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
export { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
export {
  Sidebar,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
  SidebarInset,
} from "../components/ui/sidebar";
export { Textarea } from "../components/ui/textarea";
export { toastManager } from "../components/ui/toast";
export { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
export { layer as primaryHttpLayer } from "../environments/primary/httpLayer";
export { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
export { newThreadId, randomUUID, newMessageId } from "../lib/utils";
export {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
export {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
export { useRightPanelStore } from "../rightPanelStore";
export { appAtomRegistry } from "../rpc/atomRegistry";
export { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
export {
  useProjects,
  useThreadShells,
  useProject,
  readThreadShells,
  useQuietThreadShells,
} from "../state/entities";
export {
  useEnvironmentProviders,
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  readPrimaryEnvironmentId,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "../state/environments";
export { environmentSummaries } from "../state/presentation";
export { EMPTY_SERVER_PROVIDERS } from "../state/server";
export { readPreparedConnection, readEnvironmentScope } from "../state/session";
export { environmentThreadDetails, threadEnvironment } from "../state/threads";
export { useOrchestrationCommand } from "../state/use-orchestration-command";
export { buildThreadRouteParams } from "../threadRoutes";
export { WorkspacePageHeader } from "../components/WorkspacePageHeader";
export { isElectron } from "../env";
