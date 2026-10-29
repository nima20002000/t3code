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
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
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
export { ComposerHandleContext, type ComposerHandleRef } from "../composerHandleContext";
export { HostSetupRunnerContext } from "../browser/hostSetupRunner";
export {
  ComposerNewThreadContext,
  type ComposerNewThreadSettings,
} from "../components/chat/composerNewThread";
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
export { environmentSession, readPreparedConnection, readEnvironmentScope } from "../state/session";
export { environmentThreadDetails, threadEnvironment } from "../state/threads";
export { useOrchestrationCommand } from "../state/use-orchestration-command";
export { buildThreadRouteParams } from "../threadRoutes";
export { WorkspacePageHeader } from "../components/WorkspacePageHeader";
export { isElectron } from "../env";
export { PersistentThreadTerminalPanel } from "../components/PersistentThreadTerminals";
export { useThreadTerminalActions } from "../components/terminal/useThreadTerminalActions";
export { PreviewPanel } from "../components/preview/PreviewPanel";
export { openPreviewSession } from "../components/preview/openPreviewSession";
export { closePreviewSession } from "../components/preview/closePreviewSession";
export { previewEnvironment } from "../state/preview";
export { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
export { useThreadPreviewState } from "../previewStateStore";
export { rendersServerTabNatively } from "../browser/previewRuntime";
export { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
export { withDesktopTab } from "../browser/desktopTabLifetime";
export { useAtomCommand } from "../state/use-atom-command";
export { primaryServerKeybindingsAtom } from "../state/server";
export { readLocalApi } from "../localApi";
export { useStableCallback } from "../hooks/useStableCallback";
