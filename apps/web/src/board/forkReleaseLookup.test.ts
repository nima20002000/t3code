import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeForkReleaseSource } from "./forkReleaseLookup";

/** A fake GitHub release index; `respond` picks each request's reply and every request counts. */
function github(respond: (page: string | null) => Response) {
  const requests: Array<string | null> = [];
  const client = HttpClient.make((request) => {
    const page = new URL(request.url).searchParams.get("page");
    requests.push(page);
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(page)));
  });
  return { client, requests };
}

it.effect("finds a published exact fork version beyond the first release page", () =>
  Effect.gen(function* () {
    const { client } = github((page) =>
      Response.json(
        page === "1"
          ? Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.1.6-board.${index + 1}` }))
          : [{ tag_name: "v0.1.5-board.4" }],
      ),
    );
    const release = yield* makeForkReleaseSource()
      .lookup("0.1.5-board.4")
      .pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(release?.version).toBe("0.1.5-board.4");
  }),
);

it.effect("finds the newest full fork release even when prereleases fill the first page", () =>
  Effect.gen(function* () {
    const { client } = github((page) =>
      Response.json(
        page === "1"
          ? Array.from({ length: 100 }, (_, index) => ({
              tag_name: `v0.1.7-board.${index + 1}`,
              prerelease: true,
            }))
          : [{ tag_name: "v0.1.6" }, { tag_name: "v0.1.5-board.10" }],
      ),
    );
    const release = yield* makeForkReleaseSource()
      .lookup("latest")
      .pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(release?.version).toBe("0.1.5-board.10");
  }),
);

it.effect("every version a client asks about shares one fetch of the release list", () =>
  Effect.gen(function* () {
    const { client, requests } = github(() =>
      Response.json([{ tag_name: "v0.1.5-board.4" }, { tag_name: "v0.1.5-board.3" }]),
    );
    const { lookup } = makeForkReleaseSource();
    const found = yield* Effect.all(
      [lookup("latest"), lookup("0.1.5-board.4"), lookup("0.1.5-board.3"), lookup("0.1.9")],
      { concurrency: "unbounded" },
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(found.map((release) => release?.version ?? null)).toEqual([
      "0.1.5-board.4",
      "0.1.5-board.4",
      "0.1.5-board.3",
      null,
    ]);
    expect(requests).toHaveLength(1);
    yield* TestClock.adjust("5 minutes");
    yield* lookup("latest").pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(requests).toHaveLength(2);
  }),
);

it.effect("a rate-limited GitHub is left alone until its limit resets", () =>
  Effect.gen(function* () {
    let limited = false;
    const { client, requests } = github(() =>
      limited
        ? new Response("rate limited", {
            status: 403,
            headers: { "x-ratelimit-reset": String(20 * 60) },
          })
        : Response.json([{ tag_name: "v0.1.5-board.4" }]),
    );
    const { lookup } = makeForkReleaseSource();
    const run = lookup("latest").pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect((yield* run)?.version).toBe("0.1.5-board.4");
    limited = true;
    yield* TestClock.adjust("5 minutes");
    // The last good list still answers while GitHub refuses.
    expect((yield* run)?.version).toBe("0.1.5-board.4");
    expect(requests).toHaveLength(2);
    yield* TestClock.adjust("10 minutes");
    yield* run;
    expect(requests).toHaveLength(2);
    limited = false;
    yield* TestClock.adjust("6 minutes");
    yield* run;
    expect(requests).toHaveLength(3);
  }),
);
