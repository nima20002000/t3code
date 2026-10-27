import { useState } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../upstream";

/** The workflow name as a heading; click (or Rename in the actions menu) to edit it in place. */
export function WorkflowName(props: {
  readonly name: string;
  readonly onRename: (name: string) => void;
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState(props.name);

  const commit = () => {
    if (draft.trim() !== "" && draft.trim() !== props.name) {
      props.onRename(draft.trim());
    }
    setDraft(props.name);
    props.onEditingChange(false);
  };

  return (
    <div className="board-name">
      {!props.editing ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="board-name-text cursor-text truncate text-left"
                onClick={() => {
                  setDraft(props.name);
                  props.onEditingChange(true);
                }}
              >
                {props.name}
              </button>
            }
          />
          <TooltipPopup>Rename workflow</TooltipPopup>
        </Tooltip>
      ) : (
        <input
          className="board-name-text"
          aria-label="Workflow name"
          value={draft}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            else if (event.key === "Escape") {
              setDraft(props.name);
              props.onEditingChange(false);
            }
          }}
        />
      )}
    </div>
  );
}
