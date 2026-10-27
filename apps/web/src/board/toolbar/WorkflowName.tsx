import { useImperativeHandle, useRef, useState, type Ref } from "react";

export interface WorkflowNameHandle {
  begin(): void;
}

/** The workflow name as a heading; click (or Rename in the actions menu) to edit it in place. */
export function WorkflowName(props: {
  readonly name: string;
  readonly onRename: (name: string) => void;
  readonly ref?: Ref<WorkflowNameHandle>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(props.ref, () => ({
    begin: () => {
      setDraft(props.name);
      requestAnimationFrame(() => input.current?.select());
    },
  }));

  const commit = () => {
    if (draft !== null && draft.trim() !== "" && draft.trim() !== props.name) {
      props.onRename(draft.trim());
    }
    setDraft(null);
  };

  return (
    <div className="board-name">
      {draft === null ? (
        <button
          type="button"
          className="board-name-button"
          title="Rename workflow"
          onClick={() => {
            setDraft(props.name);
            requestAnimationFrame(() => input.current?.select());
          }}
        >
          {props.name}
        </button>
      ) : (
        <input
          ref={input}
          className="board-name-field"
          aria-label="Workflow name"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            else if (event.key === "Escape") setDraft(null);
          }}
        />
      )}
    </div>
  );
}
