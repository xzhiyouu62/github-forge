# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xzhiyouu62/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xzhiyouu62/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge that runs as one Node process with no
dependencies, no disk state and no `git` binary. Everything lives in an in-memory,
content-addressed object store (SHA-1), and the four surfaces agents already speak
are served from that single store:

| Route | What it is |
| --- | --- |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs` (protocol v0 and v2), `git-upload-pack` (ls-refs, fetch, shallow/deepen), `git-receive-pack` (report-status, fast-forward-only) |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, git refs/trees/blobs, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4 subset: viewer, repository, issue/pull-request connections with cursor pagination, `node(id:)`, introspection, and the issue/PR/comment mutations |
| `POST /mcp` | Model Context Protocol (JSON-RPC): `server/discover`, `initialize`, `tools/list`, `tools/call` with the six repository tools |

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips the
TypeScript types on its own. There is nothing to install: the program imports only
Node built-ins and its own sources.

## Lifecycle

`main.ts` owns the process lifecycle of the agent/v1 harness: it reads
`MAKEFUN_ENV_URL`, binds an ephemeral port, POSTs `{"port": N}` to the env's
`/register`, serves until GET `/done` answers `{"done": true}`, then closes the
server and exits 0. `app.ts` builds the HTTP server; the forge's state is one
`Forge` instance created empty at boot (the suite creates every repository,
issue and branch through the API itself).

## Layout

- `main.ts` — the harness lifecycle described above
- `app.ts` — HTTP server: bearer auth, routing, JSON plumbing
- `store.ts` — the in-memory forge state (repositories, issues, pull requests, labels, comments)
- `gitobj.ts` — the SHA-1 object store: blobs, trees, commits, ancestry, merge-base
- `pack.ts` — pkt-line codec, packfile writer/reader (OFS/REF delta resolution), delta application
- `git.ts` — git smart HTTP: advertisements, ls-refs, fetch (with fetch-response caching), receive-pack
- `rest.ts` — the REST v3 surface, including the three-way tree merge behind squash merges
- `graphql.ts` — a small GraphQL parser, schema, validator and executor for the v4 subset
- `mcp.ts` — the MCP endpoint and its six tools, over the same store as REST

## License

MIT — see `LICENSE`.
