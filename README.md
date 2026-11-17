# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/oponopon31/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/oponopon31/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process, standard library only. It serves git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API for repositories, issues, pull requests and contents, the GraphQL v4 API, and a Model Context Protocol endpoint — all from its own on-disk store, with no UI and no outside service. Grade-local 893.7/1000 across 3 trials (feature 600/600, agent 200/200 every trial).

## Run it

```sh
MAKEFUN_ENV_URL=<env> node main.ts
```

`MAKEFUN_ENV_URL` must name the trial environment's origin. The program binds an ephemeral port, registers it with the environment, serves until the environment says the trial is done, then exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?ref=m5sdmdqp&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
