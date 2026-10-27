import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../board/BoardPage";

export const Route = createFileRoute("/_chat/board")({
  component: BoardPage,
});
