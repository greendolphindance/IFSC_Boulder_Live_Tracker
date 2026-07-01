import { useMemo, useState } from "react";
import type { CompetitionState, LeadResult } from "../../server/src/types/domain";
import { EventFeed } from "./LiveView";
import { AthleteName } from "./AthleteName";

export function LeadView({ state, mode }: { state: CompetitionState; mode: "columns" | "axis" }) {
  const lead = state.snapshot.lead;
  const groups = lead?.genders ?? [];
  const selected = groups[0];
  const summaryEvents = state.events.filter((event) => event.type !== "SNAPSHOT_RECEIVED");

  if (!lead || !selected) {
    return (
      <main className="feed-layout">
        <section className="panel">
          <div className="section-title">Lead View</div>
          <p>Lead data is not available for this round yet.</p>
        </section>
      </main>
    );
  }

  if (mode === "axis") {
    return (
      <main className="lead-axis-layout">
        <section className="panel lead-panel">
          <LeadAxis athletes={selected.athletes} routeTop={lead.routeTop} />
        </section>
        <div className="lead-axis-feed">
          <EventFeed events={summaryEvents} athletes={state.snapshot.athletes} />
        </div>
      </main>
    );
  }

  return (
    <main className="lead-layout">
      <section className="panel lead-panel">
        <div className="section-title lead-heading">
          <span>Lead Columns</span>
        </div>
        <LeadColumns athletes={selected.athletes} roundType={lead.roundType} events={summaryEvents} state={state} />
      </section>
    </main>
  );
}

function LeadColumns({ athletes, roundType, events, state }: { athletes: LeadResult[]; roundType: string; events: CompetitionState["events"]; state: CompetitionState }) {
  const active = athletes.find((athlete) => athlete.status === "climbing");
  const next = active ? athletes.find((athlete) => athlete.next) ?? athletes.find((athlete) => athlete.status === "waiting") : undefined;
  const ranked = [...athletes].sort((a, b) => leadRankSortValue(a) - leadRankSortValue(b) || b.hold - a.hold || a.athlete.startOrder - b.athlete.startOrder);
  const appealIds = new Set(state.snapshot.appeals.filter((appeal) => appeal.status === "Under Appeal" || appeal.status === "Pending").map((appeal) => appeal.athleteId));

  return (
    <div className="lead-columns-grid">
      <div className="lead-left-column">
        <section className="lead-status-card lead-current-card">
          <div className="lead-card-title">Currently Climbing</div>
          {active ? <LeadFeatured athlete={active} /> : <div className="empty">No climber</div>}
          <div className="lead-next">Next: {next ? <AthleteName athlete={next.athlete}>{compactName(next.athlete.name)}</AthleteName> : "-"}</div>
        </section>
        <div className="lead-column-feed">
          <EventFeed events={events} athletes={state.snapshot.athletes} />
        </div>
      </div>
      <section className="lead-status-card">
        <div className="lead-card-title">Live Ranking</div>
        <div className="lead-ranking-list">
          {ranked.map((athlete) => (
            <LeadRankingRow athlete={athlete} underAppeal={appealIds.has(athlete.athlete.id)} compact={roundType === "Semi-final"} key={athlete.athlete.id} />
          ))}
        </div>
      </section>
    </div>
  );
}

function LeadFeatured({ athlete }: { athlete: LeadResult }) {
  return (
    <div className="lead-featured">
      <div>
        <AthleteName athlete={athlete.athlete} className="lead-athlete-name">{compactName(athlete.athlete.name)}</AthleteName>
        <div className="lead-meta">Elapsed {formatElapsed(athlete.elapsedSeconds ?? 0)}</div>
      </div>
      <div className={`lead-score lead-score-${athlete.status}`}>{athlete.scoreText}</div>
    </div>
  );
}

function leadRankSortValue(athlete: LeadResult) {
  if (athlete.status === "dns") return 9999;
  return athlete.rank > 0 ? athlete.rank : athlete.athlete.startOrder;
}

function LeadRankingRow({ athlete, compact, underAppeal }: { athlete: LeadResult; compact?: boolean; underAppeal?: boolean }) {
  return (
    <div className={`lead-ranking-row lead-${athlete.status} ${underAppeal ? "under-appeal" : ""} ${compact ? "compact" : ""}`}>
      <strong>{athlete.status === "dns" ? "" : `#${athlete.rank}`}</strong>
      <span><AthleteName athlete={athlete.athlete}>{compactName(athlete.athlete.name)}</AthleteName></span>
      <small>{underAppeal ? "under appeal" : ""}</small>
      <b>{athlete.scoreText}</b>
    </div>
  );
}

function LeadAxis({ athletes, routeTop }: { athletes: LeadResult[]; routeTop?: number }) {
  const [expanded, setExpanded] = useState(() => readStoredBool("ifsc-lead-axis-expanded-v2", false));
  const [magnifier, setMagnifier] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const scored = useMemo(
    () => athletes
      .filter((athlete) => athlete.status !== "waiting" && athlete.status !== "dns")
      .sort((a, b) => leadAxisValue(b) - leadAxisValue(a) || a.rank - b.rank),
    [athletes]
  );
  const axisPoints = useMemo(() => leadAxisPoints(scored), [scored]);
  const top = useMemo(() => routeTop ?? 50, [routeTop]);
  const marks = useMemo(() => axisMarks(top), [top]);

  function toggleExpanded() {
    setExpanded((value) => {
      window.localStorage.setItem("ifsc-lead-axis-expanded-v2", value ? "0" : "1");
      return !value;
    });
  }

  return (
    <>
      <div className="section-title lead-heading">
        <span>Lead Axis</span>
        <button type="button" className={`feed-top-button lead-magnifier-button ${magnifier ? "active armed" : ""}`} aria-label="Toggle axis magnifier" onClick={() => setMagnifier((value) => !value)}>⌕</button>
        <button type="button" className={`switch-toggle compact-toggle lead-axis-mobile-toggle ${expanded ? "on" : ""}`} onClick={toggleExpanded}>
          <span />
          <strong><b className="full-label">{expanded ? "Exp." : "Cpt."}</b><b className="short-label">{expanded ? "Exp." : "Cpt."}</b></strong>
        </button>
      </div>
      <div
        className={`lead-axis-wrap ${expanded ? "expanded" : ""} ${magnifier ? "magnifier-on" : ""}`}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHover({ x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height });
        }}
        onMouseLeave={() => setHover(null)}
      >
        <div className="lead-axis">
          <LeadAxisContent points={axisPoints} marks={marks} top={top} />
        </div>
        {magnifier && hover && (
          <>
            <div className="lead-magnifier-cursor" style={{ left: hover.x, top: hover.y }} />
            <div className="lead-magnifier-preview" style={{ left: hover.x, top: hover.y }}>
              <div
                className="lead-magnifier-inner"
                style={{
                  width: hover.width,
                  height: hover.height,
                  transform: `translate(${96 - hover.x * 3}px, ${96 - hover.y * 3}px) scale(3)`
                }}
              >
                <div className="lead-axis">
                  <LeadAxisContent points={axisPoints} marks={marks} top={top} />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

interface LeadAxisPoint {
  key: string;
  status: LeadResult["status"];
  value: number;
  label: string;
}

function LeadAxisContent({ points, marks, top }: { points: LeadAxisPoint[]; marks: number[]; top: number }) {
  return (
    <>
      {marks.map((mark) => (
        <div className="lead-axis-mark" style={{ bottom: `${axisPercent(mark, top)}%` }} key={mark}><span>{mark}</span></div>
      ))}
      {points.map((point) => (
        <div className={`lead-axis-point lead-${point.status}`} style={{ bottom: `${axisPercent(point.value, top)}%` }} key={point.key}>
          <span />
          <b>{point.label}</b>
        </div>
      ))}
    </>
  );
}

function leadAxisPoints(athletes: LeadResult[]): LeadAxisPoint[] {
  const points: LeadAxisPoint[] = [];
  const grouped = new Map<string, LeadResult[]>();

  for (const athlete of athletes) {
    if (athlete.status === "climbing") {
      points.push({
        key: athlete.athlete.id,
        status: athlete.status,
        value: leadAxisValue(athlete),
        label: `${compactName(athlete.athlete.name)} ${athlete.scoreText}`
      });
      continue;
    }
    const key = `${leadAxisValue(athlete)}:${athlete.scoreText}`;
    grouped.set(key, [...(grouped.get(key) ?? []), athlete]);
  }

  for (const group of grouped.values()) {
    const sorted = group.sort((a, b) => a.rank - b.rank || a.athlete.startOrder - b.athlete.startOrder);
    points.push({
      key: sorted.map((athlete) => athlete.athlete.id).join("-"),
      status: sorted.some((athlete) => athlete.status === "top") ? "top" : sorted[0].status,
      value: leadAxisValue(sorted[0]),
      label: `${sorted.map((athlete) => compactName(athlete.athlete.name)).join(", ")} ${sorted[0].scoreText}`
    });
  }

  return points.sort((a, b) => b.value - a.value || (a.status === "climbing" ? 1 : 0) - (b.status === "climbing" ? 1 : 0));
}

function leadAxisValue(athlete: LeadResult) {
  return athlete.hold + (athlete.plus ? 0.25 : 0);
}

function axisMarks(top: number) {
  const marks: number[] = [];
  for (let mark = Math.floor(top / 10) * 10; mark >= 0; mark -= 10) {
    marks.push(mark);
  }
  return [top, ...marks].filter((mark, index, all) => all.indexOf(mark) === index);
}

function axisPercent(value: number, top: number) {
  return Math.max(0, Math.min(100, (value / top) * 100));
}

function compactName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function readStoredBool(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === "1";
}
