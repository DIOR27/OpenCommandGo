#!/usr/bin/env node

import { runCli } from "../src/cli/main.js"

await runCli(process.argv.slice(2))
