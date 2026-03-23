#!/usr/bin/env node

import { loadConfig } from "../dist/src/config.js";
import { ToseaClient } from "../dist/src/http.js";

function parseArgs(argv) {
  const parsed = {
    expectTier: undefined,
    featureKey: undefined,
    listLimit: 3
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--expect-tier") {
      parsed.expectTier = argv[index + 1];
      index += 1;
    } else if (value === "--feature-key") {
      parsed.featureKey = argv[index + 1];
      index += 1;
    } else if (value === "--list-limit") {
      parsed.listLimit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const client = new ToseaClient(config);

  const health = await client.health();
  const permissions = await client.getPermissionsSummary();
  const quota = await client.getQuotaStatus(args.featureKey);
  const presentations = await client.listPresentations(
    Number.isFinite(args.listLimit) && args.listLimit > 0 ? args.listLimit : 3,
    0
  );

  const tier = permissions.data?.user_tier;
  if (args.expectTier && tier !== args.expectTier) {
    throw new Error(`Expected tier ${args.expectTier} but received ${tier}`);
  }

  const output = {
    checked_at: new Date().toISOString(),
    tier,
    health,
    permissions,
    quota,
    presentations
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
