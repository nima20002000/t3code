import { CopyIcon, PencilIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import {
  createNewWorkflow,
  duplicateWorkflow,
  removeWorkflow,
  setCurrentWorkflow,
  useBoards,
} from "../boardStore";
import { IconButton } from "./IconButton";

/** Foreman's gear "Workflow actions" menu, plus a switcher between workflows. */
export function WorkflowMenu(props: { readonly onRename: () => void }) {
  const { workflows, currentId } = useBoards();
  const current = workflows.find((workflow) => workflow.id === currentId) ?? workflows[0];

  return (
    <Menu>
      <MenuTrigger render={<IconButton label="Workflow actions" />}>
        <SettingsIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Workflows</MenuGroupLabel>
          <MenuRadioGroup value={currentId} onValueChange={(value) => setCurrentWorkflow(value)}>
            {workflows.map((workflow) => (
              <MenuRadioItem key={workflow.id} value={workflow.id} closeOnClick>
                <span className="truncate">{workflow.name}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => createNewWorkflow()}>
          <PlusIcon />
          New workflow
        </MenuItem>
        <MenuItem onClick={props.onRename}>
          <PencilIcon />
          Rename
        </MenuItem>
        <MenuItem onClick={() => current && duplicateWorkflow(current.id)}>
          <CopyIcon />
          Duplicate (settings only)
        </MenuItem>
        <MenuItem
          variant="destructive"
          onClick={() => {
            if (!current) return;
            if (
              window.confirm(`Remove workflow "${current.name}"? Its agents' threads are kept.`)
            ) {
              removeWorkflow(current.id);
            }
          }}
        >
          <Trash2Icon />
          Remove workflow
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
