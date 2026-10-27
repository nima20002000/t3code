import { Handle, Position } from "@xyflow/react";

const hidden = [
  ["top", Position.Top],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const;

/**
 * Copied from Foreman Code. One visible port on the right rim starts a connection; the whole
 * circle accepts one. The other side ids stay mounted, invisible, so connections that name them
 * still resolve.
 */
export function AgentHandles({ name }: { name: string }) {
  return (
    <>
      {hidden.map(([id, position]) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={position}
          isConnectable={false}
          className="n-agent-side"
        />
      ))}
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="n-agent-port"
        aria-label={`Connect ${name} to another agent`}
        title="Drag this handle to another agent"
      />
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        className="n-agent-target"
        aria-label={`Connect to ${name}`}
      />
    </>
  );
}
