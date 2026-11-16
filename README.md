# forge — a GitHub-compatible git forge

A standalone, GitHub-compatible git forge in one Node process, standard library
only. It serves git smart HTTP (upload-pack v2, receive-pack v0), the REST v3
API for repositories, issues, pull requests and contents, the GraphQL v4 API,
and a Model Context Protocol endpoint — all from its own on-disk store, with no
UI and no outside service.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge"
competition.

## Run it

```sh
node main.ts
```

`MAKEFUN_ENV_URL` must name the trial environment's origin. The program binds
an ephemeral port, registers it with the environment, serves until the
environment says the trial is done, then exits 0.
