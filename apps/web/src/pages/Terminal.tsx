import { api } from "../api";
import { useAsync } from "../components/common";
import { CommandTerminal, StatusLine } from "../components/CommandHero";

/** Explore by command: a verb plus an asset the user types or picks; results open on demand. */
export function TerminalPage() {
  const cov = useAsync((s) => api.coverage(s), []);
  const rows = cov.data?.rows ?? null;
  return (
    <div className="home-wide">
      <section className="cmd-hero term-hero">
        <StatusLine protocols={rows ? new Set(rows.flatMap((r) => r.protocols)).size : null} />
        <CommandTerminal />
      </section>
    </div>
  );
}
