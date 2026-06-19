import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AthleteRoundResult, CompetitionEvent, CompetitionState } from "../../server/src/types/domain";
import { athleteById } from "../lib/format";

interface Props {
  state: CompetitionState;
  mode: "routes" | "athletes" | "feed";
}

export function LiveView({ state, mode }: Props) {
  const athleteMainRef = useRef<HTMLDivElement>(null);
  const routePanelRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const athleteSyncedHeight = useElementHeight(athleteMainRef);
  const routePanelHeight = useElementHeight(routePanelRef);
  const routeSyncedHeight = !isMobile && routePanelHeight ? Math.max(720, routePanelHeight + 36 + 240) : 0;
  const routeColumnStyle = routeSyncedHeight ? { height: `${routeSyncedHeight}px` } : undefined;
  const summaryEvents = state.events
    .filter((event) => event.type !== "SNAPSHOT_RECEIVED");

  if (mode === "feed") {
    return (
      <main className="feed-layout">
        <EventFeed events={summaryEvents} athletes={state.snapshot.athletes} />
      </main>
    );
  }

  if (mode === "athletes") {
    return (
      <main className="live-layout athlete-layout">
        <section className="main-column">
          <div ref={athleteMainRef}>
            <RankingPanel state={state} boxed splitGroups compactWidth />
          </div>
        </section>
        <aside className="side-column" style={athleteSyncedHeight ? { height: `${athleteSyncedHeight}px` } : undefined}>
          <RouteSummaryPanel state={state} />
          <div className="desktop-event-feed athlete-side-feed">
            <EventFeed events={summaryEvents} athletes={state.snapshot.athletes} />
          </div>
        </aside>
      </main>
    );
  }

  return (
    <main className="live-layout routes-layout">
      <section className="main-column" style={routeColumnStyle}>
        <div ref={routePanelRef}>
          <RoutePanel state={state} />
        </div>
        <div className="desktop-event-feed route-feed">
          <EventFeed events={summaryEvents} athletes={state.snapshot.athletes} />
        </div>
      </section>
      <aside className="side-column" style={routeColumnStyle}>
        <RankingPanel state={state} />
      </aside>
    </main>
  );
}

function useElementHeight<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}

function RoutePanel({ state, compact = false }: { state: CompetitionState; compact?: boolean }) {
  const routeGroups = groupedRoutes(state);
  const isMobile = useIsMobile();
  const [selectedGroup, setSelectedGroup] = useState(() => readStoredValue("ifsc-route-view-group", routeGroups[0]?.name ?? "Routes"));
  useEffect(() => {
    const names = routeGroups.map((group) => group.name);
    if (!names.includes(selectedGroup)) setSelectedGroup(names[0] ?? "Routes");
  }, [routeGroups, selectedGroup]);
  useEffect(() => {
    window.localStorage.setItem("ifsc-route-view-group", selectedGroup);
  }, [selectedGroup]);
  return (
    <section className="panel focus-panel">
      <div className="section-title route-heading">
        <span>{compact ? "Routes" : "Route View"}</span>
        {isMobile && routeGroups.length > 1 && (
          <button type="button" className={`switch-toggle heading-switch ${selectedGroup === routeGroups[1]?.name ? "on" : ""}`} onClick={() => setSelectedGroup(selectedGroup === routeGroups[0].name ? routeGroups[1].name : routeGroups[0].name)}>
            <span />
            <strong>{selectedGroup}</strong>
          </button>
        )}
      </div>
      <div className="climber-list grouped">
        {routeGroups.map((group) => (
          <section className={`climber-group ${selectedGroup === group.name ? "selected-mobile-group" : ""}`} key={group.name}>
            {routeGroups.length > 1 && <div className="group-title">{group.name}</div>}
            <div className="route-row">
              {group.routes.map((route) => (
                <RouteTile key={`${group.name}-${route.boulderNo}`} state={state} route={route} showNext={!compact} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function RouteTile({ state, route, showNext }: { state: CompetitionState; route: RouteSlot; showNext: boolean }) {
  const live = route.live;
  const result = live ? athleteById(state.snapshot.athletes, live.athleteId) : undefined;
  const next = showNext ? nextForRoute(state, route.group, route.boulderNo) : undefined;
  return (
    <article className={`route-tile ${live ? "active-route" : ""}`}>
      <div className="route-header">
        <div className="route-id">{routeLabel(state, route.group, route.boulderNo)}</div>
        <div className="athlete-name">{result ? displayName(result.athlete.name) : "Open"}</div>
      </div>
      {result && live ? (
        <>
          <div className="route-body">
            <MiniBoulders boulders={result.boulders} currentBoulder={live.currentBoulder} currentAttempt={live.currentAttempt} roundFinished={isFinishedRound(state)} />
            <div className="score-block">
              <span>{displayScore(result)}</span>
              <strong>{displayRankLabel(result)}</strong>
            </div>
          </div>
          {showNext && <div className="next-line">Next: {next ? displayName(next.name) : "-"}</div>}
        </>
      ) : (
        <>
          <div className="empty-route">No climber</div>
          {showNext && <div className="next-line">Next: {next ? displayName(next.name) : "-"}</div>}
        </>
      )}
    </article>
  );
}

function RouteSummaryPanel({ state }: { state: CompetitionState }) {
  const routeGroups = groupedRoutes(state);
  return (
    <section className="panel">
      <div className="section-title">Routes</div>
      <div className="route-summary-panel">
        {routeGroups.map((group) => (
          <section className="ranking-group" key={group.name}>
            {routeGroups.length > 1 && <div className="ranking-group-title">{group.name}</div>}
            <div className="ranking-list">
              {group.routes.map((route) => (
                <RouteSummaryRow state={state} route={route} key={`${group.name}-${route.boulderNo}`} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function RouteSummaryRow({ state, route }: { state: CompetitionState; route: RouteSlot }) {
  const live = route.live;
  const result = live ? athleteById(state.snapshot.athletes, live.athleteId) : undefined;
  return (
    <div className={`ranking-row route-summary-row ${live ? "active-ranking" : ""}`}>
      <strong>{routeLabel(state, route.group, route.boulderNo)}</strong>
      <span className="ranking-name">{result ? displayName(result.athlete.name) : "Open"}</span>
      {result && live ? (
        <>
          <RankingBoulders boulders={result.boulders} currentBoulder={live.currentBoulder} currentAttempt={live.currentAttempt} roundFinished={isFinishedRound(state)} />
          <span className="ranking-score">{displayScore(result)}</span>
        </>
      ) : (
        <>
          <span className="ranking-empty-cells">-</span>
          <span className="ranking-score muted-score">-</span>
        </>
      )}
    </div>
  );
}

function RankingPanel({ state, boxed = false, splitGroups = false, compactWidth = false }: { state: CompetitionState; boxed?: boolean; splitGroups?: boolean; compactWidth?: boolean }) {
  const isMobile = useIsMobile();
  const rankingGroups = groupedRankings(state, splitGroups && !isMobile);
  const grouped = rankingGroups.filter((group) => !group.continuation);
  const groupStorageKey = splitGroups ? "ifsc-athlete-ranking-group" : "ifsc-route-ranking-group";
  const [selectedGroup, setSelectedGroup] = useState(() => readStoredValue(groupStorageKey, grouped[0]?.name ?? "All"));
  const [compactRows, setCompactRows] = useState(() => readStoredBool("ifsc-athlete-ranking-compact", false));
  const shouldSelectGroup = grouped.length > 1 && (!splitGroups || isMobile);
  const visibleGroups = shouldSelectGroup ? rankingGroups.filter((group) => group.name === selectedGroup) : rankingGroups;
  const visibleResultCount = visibleGroups.reduce((total, group) => total + group.results.length, 0);
  const activeIds = useMemo(() => new Set(state.currentClimbers.map((climber) => climber.athleteId)), [state.currentClimbers]);
  const split = splitGroups && rankingGroups.length > 1 && !shouldSelectGroup;
  useEffect(() => {
    const names = grouped.map((group) => group.name);
    if (!names.includes(selectedGroup)) setSelectedGroup(names[0] ?? "All");
  }, [grouped, selectedGroup]);
  useEffect(() => {
    window.localStorage.setItem(groupStorageKey, selectedGroup);
  }, [groupStorageKey, selectedGroup]);
  useEffect(() => {
    window.localStorage.setItem("ifsc-athlete-ranking-compact", compactRows ? "1" : "0");
  }, [compactRows]);
  return (
    <section className={`panel ranking-shell ${splitGroups ? "athlete-ranking-shell" : "route-ranking-shell"} ${!splitGroups && visibleResultCount >= 30 ? "long-ranking-shell" : ""}`}>
      <div className="section-title ranking-heading">
        <span>Live Ranking</span>
        {splitGroups && !shouldSelectGroup && (
          <button type="button" className={`compact-toggle switch-toggle desktop-heading-switch ${compactRows ? "on" : ""}`} onClick={() => setCompactRows((value) => !value)}>
            <span />
            <strong><b className="full-label">{compactRows ? "Compact" : "Expand"}</b><b className="short-label">{compactRows ? "Cpt." : "Exp."}</b></strong>
          </button>
        )}
        {splitGroups && shouldSelectGroup && (
          <div className="mobile-heading-controls">
            {grouped.length === 2 && (
              <button type="button" className={`switch-toggle heading-switch ${selectedGroup === grouped[1].name ? "on" : ""}`} onClick={() => setSelectedGroup(selectedGroup === grouped[0].name ? grouped[1].name : grouped[0].name)}>
                <span />
                <strong><b className="full-label">{selectedGroup}</b><b className="short-label">{shortGroupLabel(selectedGroup)}</b></strong>
              </button>
            )}
            <button type="button" className={`compact-toggle switch-toggle heading-switch ${compactRows ? "on" : ""}`} onClick={() => setCompactRows((value) => !value)}>
              <span />
              <strong><b className="full-label">{compactRows ? "Compact" : "Expand"}</b><b className="short-label">{compactRows ? "Cpt." : "Exp."}</b></strong>
            </button>
          </div>
        )}
      </div>
      {shouldSelectGroup && !splitGroups && (
        <div className="ranking-switch switch-row">
          <div className="desktop-group-buttons">
            {grouped.map((group) => (
              <button type="button" className={`pill-switch ${selectedGroup === group.name ? "active" : ""}`} onClick={() => setSelectedGroup(group.name)} key={group.name}>
                {group.name}
              </button>
            ))}
          </div>
          {grouped.length === 2 && (
            <button type="button" className={`switch-toggle mobile-group-toggle ${selectedGroup === grouped[1].name ? "on" : ""}`} onClick={() => setSelectedGroup(selectedGroup === grouped[0].name ? grouped[1].name : grouped[0].name)}>
              <span />
              <strong>{selectedGroup}</strong>
            </button>
          )}
          {splitGroups && (
            <button type="button" className={`compact-toggle switch-toggle ${compactRows ? "on" : ""}`} onClick={() => setCompactRows((value) => !value)}>
              <span />
              <strong><b className="full-label">{compactRows ? "Compact" : "Expand"}</b><b className="short-label">{compactRows ? "Cpt." : "Exp."}</b></strong>
            </button>
          )}
          {splitGroups && (
            <button type="button" className={`compact-toggle desktop-compact-toggle pill-switch ${compactRows ? "active" : ""}`} onClick={() => setCompactRows((value) => !value)}>
              {compactRows ? "Compact" : "Expand"}
            </button>
          )}
        </div>
      )}
      <div className={`ranking-panel ${boxed ? "boxed" : ""} ${split ? "split" : ""} ${compactWidth ? "compact-width" : ""} ${compactRows && splitGroups ? "compact-ranking" : ""}`}>
        {visibleGroups.map((group, index) => (
          <section className="ranking-group" key={`${group.name}-${index}`}>
            {split && group.name !== "Ranking" && <div className="ranking-group-title">{group.name}</div>}
            <div className="ranking-list">
              {group.results.map((result) => {
                const active = activeIds.has(result.athlete.id);
                const live = state.currentClimbers.find((climber) => climber.athleteId === result.athlete.id);
                return (
                  <div className={`ranking-row ${boxed ? "ranking-card" : ""} ${active ? "active-ranking" : ""}`} key={result.athlete.id}>
                    <strong>{displayRankLabel(result)}</strong>
                    <span className="ranking-name">{displayName(result.athlete.name)}</span>
                    <RankingBoulders boulders={result.boulders} currentBoulder={live?.currentBoulder} currentAttempt={live?.currentAttempt} roundFinished={isFinishedRound(state)} />
                    <span className="ranking-score">{displayScore(result)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

export function EventFeed({ events, athletes }: { events: CompetitionEvent[]; athletes: AthleteRoundResult[] }) {
  const feedRef = useRef<HTMLDivElement>(null);
  const scrollKey = `ifsc-event-feed-scroll:${athletes.map((result) => result.athlete.id).join("-")}`;
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current || !feedRef.current) return;
    restoredRef.current = true;
    const stored = Number(window.localStorage.getItem(scrollKey) ?? 0);
    if (Number.isFinite(stored)) feedRef.current.scrollTop = stored;
  }, [scrollKey, events.length]);

  return (
    <section className="panel">
      <div className="section-title event-feed-title">
        <span>Event Feed</span>
        <button type="button" className="feed-top-button" aria-label="Scroll event feed to newest event" onClick={() => {
          feedRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          window.localStorage.setItem(scrollKey, "0");
        }}>↑</button>
      </div>
      <div className="event-list scrollable-feed" ref={feedRef} onScroll={(event) => window.localStorage.setItem(scrollKey, String(event.currentTarget.scrollTop))}>
        {events.length === 0 ? <div className="empty compact-empty">No competition events in this session.</div> : events.map((event) => (
          <div className={`event-row ${eventTypeClass(event)}`} key={event.id}>
            <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
            <span>{boldAthleteNames(event.message, athletes)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

interface RouteSlot {
  group?: string;
  boulderNo: number;
  live?: CompetitionState["currentClimbers"][number];
}

function groupedRoutes(state: CompetitionState) {
  const groups = groupNames(state);
  const maxBoulders = Math.max(4, ...state.snapshot.athletes.map((result) => result.boulders.length));
  return groups.map((group) => ({
    name: group ?? "Routes",
    routes: routeAssignmentsForGroup(state, group, maxBoulders)
  }));
}

function routeAssignmentsForGroup(state: CompetitionState, group: string | undefined, maxBoulders: number): RouteSlot[] {
  const routes: RouteSlot[] = Array.from({ length: maxBoulders }, (_, index) => ({ group, boulderNo: index + 1 }));
  const groupClimbers = state.currentClimbers
    .filter((climber) => (climber.startingGroup ?? undefined) === group)
    .sort((a, b) => athleteStartOrder(state, a.athleteId) - athleteStartOrder(state, b.athleteId));
  const occupied = new Set<number>();

  for (const climber of groupClimbers) {
    const preferred = clampRoute(climber.currentBoulder, maxBoulders);
    const boulderNo = preferred && !occupied.has(preferred) ? preferred : firstOpenRoute(occupied, maxBoulders, preferred);
    if (!boulderNo) continue;
    occupied.add(boulderNo);
    routes[boulderNo - 1].live = { ...climber, currentBoulder: boulderNo };
  }

  return routes;
}

function athleteStartOrder(state: CompetitionState, athleteId: string) {
  return state.snapshot.athletes.find((result) => result.athlete.id === athleteId)?.athlete.startOrder ?? 999;
}

function clampRoute(route: number | undefined, maxBoulders: number) {
  return route && route >= 1 && route <= maxBoulders ? route : undefined;
}

function firstOpenRoute(occupied: Set<number>, maxBoulders: number, preferred: number | undefined) {
  const start = preferred ?? 1;
  for (let route = start; route <= maxBoulders; route += 1) {
    if (!occupied.has(route)) return route;
  }
  for (let route = 1; route < start; route += 1) {
    if (!occupied.has(route)) return route;
  }
  return undefined;
}

function groupNames(state: CompetitionState) {
  const names = [...new Set(state.snapshot.athletes.map((result) => result.startingGroup).filter(Boolean))] as string[];
  return names.length > 0 ? names.sort() : [undefined];
}

interface RankingGroup {
  name: string;
  results: AthleteRoundResult[];
  continuation: boolean;
}

function groupedRankings(state: CompetitionState, allowSingleGroupSplit = false): RankingGroup[] {
  const ranked = state.snapshot.athletes
    .sort((a, b) => rankSortValue(a) - rankSortValue(b) || b.score - a.score || a.athlete.startOrder - b.athlete.startOrder);
  const names = [...new Set(ranked.map((result) => result.startingGroup).filter(Boolean))] as string[];
  if (names.length < 2) {
    const results = ranked;
    if (allowSingleGroupSplit && results.length > 16) {
      const midpoint = Math.ceil(results.length / 2);
      return [
        { name: "Ranking", results: results.slice(0, midpoint), continuation: false },
        { name: "Ranking", results: results.slice(midpoint), continuation: true }
      ];
    }
    return [{ name: "All", results, continuation: false }];
  }
  return names.sort().map((name) => ({
    name,
    results: ranked.filter((result) => result.startingGroup === name),
    continuation: false
  }));
}

function rankSortValue(result: AthleteRoundResult) {
  const officialRank = result.groupRank ?? result.rank;
  return officialRank >= 999 ? 10000 + result.athlete.startOrder : officialRank;
}

function routeLabel(state: CompetitionState, group?: string, boulder?: number) {
  const gender = state.snapshot.roundName.toLowerCase().includes("men") && !state.snapshot.roundName.toLowerCase().includes("women") ? "M" : "W";
  const groupLetter = group?.replace("Group ", "") ?? "";
  return `${gender}${groupLetter}${boulder ?? "?"}`;
}

function nextForRoute(state: CompetitionState, group?: string, boulder?: number) {
  if (isInactiveRound(state)) return undefined;
  if (!hasCompetitionStarted(state)) return undefined;
  if (!boulder) return undefined;
  const activeIds = new Set(state.currentClimbers.map((climber) => climber.athleteId));
  const routeLive = state.currentClimbers.find((climber) => (climber.startingGroup ?? undefined) === group && climber.currentBoulder === boulder)
    ?? state.currentClimbers.find((climber) => climber.currentBoulder === boulder);
  const currentPosition = routeLive ? routePosition(state, routeLive.athleteId, boulder) : completedRoutePosition(state, group, boulder);
  const positionedCandidates = state.snapshot.startlist
    .map((entry) => {
      const result = athleteById(state.snapshot.athletes, entry.athleteId);
      const position = entry.routePositions?.find((item) => item.boulderNo === boulder)?.position;
      return { entry, result, position };
    })
    .filter((candidate) => candidate.result && candidate.position !== undefined)
    .filter((candidate) => (group ? candidate.result?.startingGroup === group : true))
    .filter((candidate) => !activeIds.has(candidate.entry.athleteId) && !isDnsResult(candidate.result!))
    .filter((candidate) => currentPosition === undefined || candidate.position! > currentPosition)
    .sort((a, b) => a.position! - b.position! || a.result!.athlete.startOrder - b.result!.athlete.startOrder);
  const positioned = positionedCandidates[0]?.result?.athlete;
  if (positioned) return positioned;

  const match = state.upNext.find((entry) => entry.startingGroup === group && entry.expectedBoulder === boulder) ?? state.upNext.find((entry) => entry.expectedBoulder === boulder);
  if (match) return athleteById(state.snapshot.athletes, match.athleteId)?.athlete;

  const currentOrder = routeLive ? athleteById(state.snapshot.athletes, routeLive.athleteId)?.athlete.startOrder : completedRouteOrder(state, group, boulder);
  return state.snapshot.athletes
    .filter((result) => (group ? result.startingGroup === group : true))
    .filter((result) => !activeIds.has(result.athlete.id) && !isDnsResult(result))
    .filter((result) => (result.nextBoulder ?? nextUnfinishedBoulder(result.boulders)) === boulder)
    .filter((result) => currentOrder === undefined || result.athlete.startOrder > currentOrder)
    .sort((a, b) => a.athlete.startOrder - b.athlete.startOrder)[0]?.athlete;
}

function routePosition(state: CompetitionState, athleteId: string, boulder: number) {
  return state.snapshot.startlist
    .find((entry) => entry.athleteId === athleteId)
    ?.routePositions?.find((position) => position.boulderNo === boulder)?.position;
}

function completedRoutePosition(state: CompetitionState, group: string | undefined, boulder: number) {
  const positions = state.snapshot.athletes
    .filter((result) => (group ? result.startingGroup === group : true))
    .filter((result) => hasRouteResult(result, boulder))
    .map((result) => routePosition(state, result.athlete.id, boulder))
    .filter((position): position is number => Number.isFinite(position));
  return positions.length > 0 ? Math.max(...positions) : undefined;
}

function completedRouteOrder(state: CompetitionState, group: string | undefined, boulder: number) {
  const orders = state.snapshot.athletes
    .filter((result) => (group ? result.startingGroup === group : true))
    .filter((result) => hasRouteResult(result, boulder))
    .map((result) => result.athlete.startOrder);
  return orders.length > 0 ? Math.max(...orders) : undefined;
}

function hasRouteResult(result: AthleteRoundResult, boulder: number) {
  const route = result.boulders.find((item) => item.boulderNo === boulder);
  return Boolean(route && (route.hasZone || route.hasTop || isSlashedBoulder(route)));
}

function nextUnfinishedBoulder(boulders: MiniBoulder[]) {
  return boulders.find((boulder) => !boulder.hasTop)?.boulderNo;
}

function MiniBoulders({ boulders, currentBoulder, currentAttempt, roundFinished = false }: { boulders: MiniBoulder[]; currentBoulder?: number; currentAttempt?: number; roundFinished?: boolean }) {
  const slashedBoulders = inferNoScoreBoulders(boulders, currentBoulder, roundFinished);
  return (
    <div className="mini-boulders" style={{ gridTemplateColumns: `repeat(${boulders.length}, var(--mini-cell-width, 20px))` }}>
      {boulders.map((boulder) => (
        <MiniCell boulder={boulder} current={currentBoulder === boulder.boulderNo} currentAttempt={currentAttempt} inferredNoScore={slashedBoulders.has(boulder.boulderNo)} key={boulder.boulderNo} />
      ))}
      {currentAttempt ? <div className="mini-attempt-side blink">{currentAttempt}</div> : null}
    </div>
  );
}

function RankingBoulders({ boulders, currentBoulder, currentAttempt, roundFinished = false }: { boulders: MiniBoulder[]; currentBoulder?: number; currentAttempt?: number; roundFinished?: boolean }) {
  const slashedBoulders = inferNoScoreBoulders(boulders, currentBoulder, roundFinished);
  return (
    <div className="ranking-boulders">
      {boulders.map((boulder) => (
        <MiniCell boulder={boulder} current={currentBoulder === boulder.boulderNo} inferredNoScore={slashedBoulders.has(boulder.boulderNo)} small key={boulder.boulderNo} />
      ))}
      {currentAttempt ? <div className="ranking-attempt-side blink">{currentAttempt}</div> : null}
    </div>
  );
}

interface MiniBoulder {
  boulderNo: number;
  hasZone: boolean;
  hasTop: boolean;
  attemptsToZone?: number;
  attemptsToTop?: number;
  rawStatus?: string;
}

function MiniCell({ boulder, current, currentAttempt, small = false, inferredNoScore = false }: { boulder: MiniBoulder; current?: boolean; currentAttempt?: number; small?: boolean; inferredNoScore?: boolean }) {
  const className = `${small ? "ranking-cell" : "mini-cell"} ${boulder.hasTop ? "top" : boulder.hasZone ? "zone" : ""} ${isSlashedBoulder(boulder) || inferredNoScore ? "expired" : ""} ${current ? "current" : ""}`;
  return (
    <div className={small ? "ranking-wrap" : "mini-wrap"}>
      <div className={className}>
        {boulder.hasTop ? (
          <>
            <span className="top-tries cell-half top-half">{boulder.attemptsToTop}</span>
            <span className="zone-tries cell-half zone-half">{boulder.attemptsToZone}</span>
          </>
        ) : boulder.hasZone ? (
          <span className="zone-only cell-half zone-half">{boulder.attemptsToZone}</span>
        ) : null}
      </div>
      {current && currentAttempt ? <div className={`${small ? "ranking-attempt" : "mini-attempt"} blink`}>{currentAttempt}</div> : null}
    </div>
  );
}

function eventTypeClass(event: CompetitionEvent) {
  if (event.type === "RANK_CHANGED") {
    const match = event.reason.match(/Rank\s+(\d+)\s*->\s*(?:Rank\s*)?(\d+)/i);
    const before = Number(match?.[1]);
    const after = Number(match?.[2]);
    if (Number.isFinite(before) && Number.isFinite(after)) return after < before ? "event-rank-up" : "event-rank-down";
    if (/passed/i.test(event.message)) return "event-rank-up";
    return "event-default";
  }
  if (event.reason === "lead-fall") return "event-fall";
  if (event.type.includes("APPEAL")) return "event-appeal";
  if (event.type === "TOP_REACHED") return "event-top";
  if (event.type === "ZONE_REACHED") return "event-zone";
  return "event-default";
}

function isSlashedBoulder(boulder: MiniBoulder) {
  if (boulder.hasZone || boulder.hasTop) return false;
  return /expired|timeout|time|confirmed|complete|done|no score|no zone|no top|fail|dns|did not start/i.test(boulder.rawStatus ?? "");
}

function inferNoScoreBoulders(boulders: MiniBoulder[], currentBoulder: number | undefined, roundFinished: boolean) {
  const latestProgress = Math.max(0, ...boulders.filter((boulder) => boulder.hasZone || boulder.hasTop).map((boulder) => boulder.boulderNo));
  const completedBefore = currentBoulder ?? latestProgress;
  return new Set(boulders
    .filter((boulder) => boulder.boulderNo !== currentBoulder)
    .filter((boulder) => !boulder.hasZone && !boulder.hasTop)
    .filter((boulder) => roundFinished || boulder.boulderNo < completedBefore || isSlashedBoulder(boulder))
    .map((boulder) => boulder.boulderNo));
}

function isInactiveRound(state: CompetitionState) {
  return /finished|complete|closed|archived|ended|not started|not_started|upcoming|scheduled|pending/i.test(state.snapshot.roundStatus ?? "");
}

function isFinishedRound(state: CompetitionState) {
  return /finished|complete|closed|archived|ended/i.test(state.snapshot.roundStatus ?? "");
}

function hasCompetitionStarted(state: CompetitionState) {
  return state.currentClimbers.length > 0 || state.snapshot.athletes.some((result) =>
    result.sourceStatus === "active"
    || Boolean(result.currentBoulder)
    || result.score > 0
    || result.boulders.some((boulder) => boulder.hasZone || boulder.hasTop || Boolean(boulder.rawStatus))
  );
}

function displayName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function displayRank(result: AthleteRoundResult) {
  const rank = result.groupRank ?? result.rank;
  return rank >= 999 ? result.athlete.startOrder : rank;
}

function displayRankLabel(result: AthleteRoundResult) {
  if (isDnsResult(result)) return "";
  return `#${displayRank(result)}`;
}

function displayScore(result: AthleteRoundResult) {
  return isDnsResult(result) ? "DNS" : result.score.toFixed(1);
}

function isDnsResult(result: AthleteRoundResult) {
  return /\bDNS\b|did not start/i.test(result.sourceStatus ?? "");
}

function shortGroupLabel(name: string) {
  return name.replace("Group", "Grp");
}

function boldAthleteNames(message: string, athletes: AthleteRoundResult[]) {
  const names = [...new Set(athletes.map((result) => result.athlete.name))]
    .filter((name) => name.length > 0 && message.includes(name))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return message;
  const pattern = new RegExp(`(${names.map(escapeRegExp).join("|")})`, "g");
  return message.split(pattern).map((part, index) => names.includes(part) ? <strong key={`${part}-${index}`}>{part}</strong> : part);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isMobile;
}

function readStoredValue(key: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

function readStoredBool(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === "1";
}
