import { Fragment, useEffect, useState, type KeyboardEvent } from "react";
import type { AthleteMedalChances, CompetitionState, MedalOutcome } from "../../server/src/types/domain";
import { LEGEND_ITEMS, MEDAL_META, rotationLabel, verdictMeta } from "../lib/medalFormat";

interface Props {
  state: CompetitionState;
  /** 轮询/连接错误（useCompetitionState）· 有值时走 error 态自动重试（TC-MEDAL-020）。 */
  error?: string | null;
}

/**
 * Medal Chances tab（决赛奖牌条件推演展示层）。
 * 像素级对齐 01.5-视觉规范 + attachments/demo/index.html（视觉冻结契约）。
 * 纯展示：只读 state.medalChances 派生结论，不做业务计算。
 */
export function MedalView({ state, error }: Props) {
  const medalChances = state.medalChances;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rotations, setRotations] = useState<Record<string, number>>({});

  // 赛制切换后清空展开态/轮换态，防残留（A→B→A · TC-MEDAL-037）。
  const discipline = medalChances?.discipline;
  useEffect(() => {
    setExpandedId(null);
    setRotations({});
  }, [discipline]);

  if (!medalChances) return null; // 兜底：App 已按 medalChances != null 门控，正常不触达。

  const stale = medalChances.pageLevelTrust === "stale";
  const rosterCount = state.snapshot.athletes.length;
  const mode: "error" | "loading" | "empty" | "ready" = error
    ? "error"
    : medalChances.athletes.length === 0
      ? rosterCount > 0
        ? "loading" // 名单已到但推演结果未就绪（过渡态）
        : "empty" // 尚无决赛选手 / 未开赛
      : "ready";

  const nameRank = buildNameRank(state);
  const rows = [...medalChances.athletes].sort(
    (a, b) => (nameRank.get(a.athleteId)?.rank ?? 999) - (nameRank.get(b.athleteId)?.rank ?? 999)
  );

  function toggleRow(athleteId: string) {
    setExpandedId((current) => (current === athleteId ? null : athleteId));
  }

  function onRowKey(event: KeyboardEvent<HTMLDivElement>, athleteId: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleRow(athleteId);
    } else if (event.key === "Escape") {
      setExpandedId(null);
    }
  }

  function rotate(rotKey: string, total: number) {
    setRotations((current) => ({ ...current, [rotKey]: ((current[rotKey] ?? 0) + 1) % total }));
  }

  return (
    <main className="medal-layout">
      {mode === "ready" && (
        <div className="legend">
          {LEGEND_ITEMS.map((item) => (
            <div className="lg-item" key={item.cls}>
              <span className={`lg-swatch ${item.cls}`} />
              <span className="lg-glyph">{item.glyph}</span>
              {item.label}
            </div>
          ))}
        </div>
      )}

      <section className="panel">
        <div className="section-title">Medal Chances</div>
        {mode === "ready" && stale && (
          <p className="section-subnote">Data may be out of date — for reference only.</p>
        )}

        {mode === "loading" && <LoadingSkeleton />}
        {mode === "empty" && <EmptyState />}
        {mode === "error" && <ErrorState />}

        {mode === "ready" && (
          <div className="medal-list">
            <div className="medal-head">
              <span className="mh-rank">#</span>
              <span className="mh-ids">
                {MEDAL_META.map((meta) => (
                  <span className="mh-id-col" key={meta.key}>
                    <span className={`medal-id ${meta.id}`} />
                  </span>
                ))}
              </span>
              <span className="mh-name">Athlete</span>
            </div>

            {rows.map((athlete) => {
              const name = nameRank.get(athlete.athleteId)?.name ?? athlete.athleteId;
              const rank = nameRank.get(athlete.athleteId)?.rank ?? 0;
              const isExpanded = expandedId === athlete.athleteId;
              return (
                <Fragment key={athlete.athleteId}>
                  <div
                    className={`medal-row ${isExpanded ? "expanded" : ""}`}
                    data-row={athlete.athleteId}
                    tabIndex={0}
                    role="button"
                    aria-expanded={isExpanded}
                    onClick={() => toggleRow(athlete.athleteId)}
                    onKeyDown={(event) => onRowKey(event, athlete.athleteId)}
                  >
                    <span className="medal-rank">{rank || ""}</span>
                    <span className="medal-dots">
                      {MEDAL_META.map((meta) => {
                        const outcome = outcomeFor(athlete, meta.key);
                        const vm = verdictMeta(outcome.verdict);
                        return (
                          <span className="medal-dot-wrap" key={meta.key}>
                            <span className={`mdot ${vm.cls}`}>
                              <span className="glyph">{vm.glyph}</span>
                            </span>
                          </span>
                        );
                      })}
                    </span>
                    <span className="medal-name-cell">
                      <span className="medal-name" title={name}>{name}</span>
                      <span className="medal-arrow">▸</span>
                    </span>
                  </div>

                  {isExpanded && (
                    <div className="medal-detail" data-detail={athlete.athleteId}>
                      {MEDAL_META.map((meta) => {
                        const outcome = outcomeFor(athlete, meta.key);
                        const rotKey = `${athlete.athleteId}-${meta.key}`;
                        return (
                          <MedalLine
                            key={meta.key}
                            label={meta.word}
                            idClass={meta.id}
                            outcome={outcome}
                            rotationIndex={rotations[rotKey] ?? 0}
                            onRotate={(total) => rotate(rotKey, total)}
                            rotKey={rotKey}
                          />
                        );
                      })}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

interface MedalLineProps {
  label: string;
  idClass: string;
  outcome: MedalOutcome;
  rotationIndex: number;
  onRotate: (total: number) => void;
  rotKey: string;
}

function MedalLine({ label, idClass, outcome, rotationIndex, onRotate, rotKey }: MedalLineProps) {
  const vm = verdictMeta(outcome.verdict);
  const isNeeds = outcome.verdict === "needs_conditions";
  const combos = outcome.conditions;
  const total = combos.length;
  const index = total > 0 ? Math.min(rotationIndex, total - 1) : 0;
  const currentCondition = outcome.degraded ? combos[0] : combos[index];
  const showRefNote = isNeeds && currentCondition?.conditionLevelTrust === "top_unconfirmed";

  return (
    <div className="medal-line">
      <div className="ml-label">
        <span className={`ml-dot ${idClass}`} />
        {label}
      </div>
      <div className="ml-body">
        <div className="verdict-line">
          <span className={`verdict ${vm.cls}`}>
            <span className="v-glyph">{vm.glyph}</span>
            {vm.label}
          </span>
          {showRefNote && <span className="ref-note">(reference only: data may be out of date)</span>}
        </div>

        {isNeeds ? (
          outcome.degraded ? (
            <div className="ml-degrade">{combos[0]?.summary}</div>
          ) : (
            <>
              <div className="ml-condition">{currentCondition?.summary}</div>
              {total > 1 && (
                <div className="rotator">
                  <span className="rot-count" data-count={rotKey}>{rotationLabel(index, total)}</span>
                  <button
                    type="button"
                    className="refresh-btn"
                    aria-label="Show another possible combination"
                    title="Show another possible combination"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRotate(total);
                    }}
                  >
                    <span className="rf-glyph">↻</span>
                  </button>
                </div>
              )}
            </>
          )
        ) : (
          <div className="ml-reason">{outcome.reason}</div>
        )}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="medal-list" aria-busy="true">
      {[0, 1, 2].map((row) => (
        <div className="skel-row" key={row}>
          <div className="skel" />
          <div className="skel" />
          <div className="skel wide" />
        </div>
      ))}
      <div className="skel-caption">Calculating medal chances… (usually &lt; 1s)</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="es-title">The final has not started yet</div>
      <div className="es-desc">
        Once the final begins, this lists what each athlete needs to secure gold / silver / bronze.
      </div>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="error-state">
      <div className="er-msg">Medal chances are temporarily unavailable</div>
      <div className="er-hint">The projection service is briefly unavailable. No action needed — it retries automatically.</div>
      <div className="er-retry">
        <span className="retry-spinner" aria-hidden="true">↻</span>
        <span>Retrying every 2s…</span>
      </div>
    </div>
  );
}

function outcomeFor(athlete: AthleteMedalChances, medal: string): MedalOutcome {
  const found = athlete.outcomes.find((outcome) => outcome.medal === medal);
  // outcomes 定长 3（gold/silver/bronze）· 兜底防御，正常必命中。
  return found ?? { medal: medal as MedalOutcome["medal"], verdict: "undecided", reason: "", conditions: [] };
}

function buildNameRank(state: CompetitionState): Map<string, { name: string; rank: number }> {
  const map = new Map<string, { name: string; rank: number }>();
  for (const result of state.snapshot.athletes) {
    map.set(result.athlete.id, { name: result.athlete.name, rank: result.rank });
  }
  return map;
}
