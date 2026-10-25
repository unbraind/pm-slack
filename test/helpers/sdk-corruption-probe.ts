/** Restart recovery in a fresh process without inheriting SDK memory caches. */
import { captureSlackOutbox, SlackOutbox } from "../../index.ts";
import { listMutationEvents, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";

const box = new SlackOutbox(process.argv[2]!);
try {
  if (process.argv[3]) {
    const page = await listMutationEvents({ pmRoot: process.argv[2]!, full: true, limit: 1000 });
    const entries = page.events.filter((event) => event.item_id === process.argv[3]).map((event) => event.entry!);
    console.error(`SDK cache observation: ${JSON.stringify({ source: page.source, cached_chain_verifies: verifyHistoryEntries(entries).ok })}`);
  }
  process.stdout.write(JSON.stringify(await captureSlackOutbox(process.argv[2]!, box)));
} finally {
  box.close();
}
