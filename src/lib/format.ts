import type { AthleteRoundResult } from "../../server/src/types/domain";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export type BoulderScoreSemantic = "score" | "dns" | "no-result";

export interface BoulderScoreDisplayInput {
  score: number;
  sourceStatus?: string;
  hasOfficialResult: boolean;
}

export function boulderScoreSemantic(input: BoulderScoreDisplayInput): BoulderScoreSemantic {
  const status = input.sourceStatus ?? "";
  if (/\bDNS\b|did not start/i.test(status)) return "dns";
  if (/\bwaiting\b|\bunranked\b|startlist(?:[-_ ]only)?|not[-_ ]started|no[-_ ](?:result|score)/i.test(status)) return "no-result";
  return input.hasOfficialResult ? "score" : "no-result";
}

export function formatBoulderScore(input: BoulderScoreDisplayInput) {
  const semantic = boulderScoreSemantic(input);
  if (semantic === "dns") return "DNS";
  if (semantic === "no-result" || !Number.isFinite(input.score)) return "-";
  return input.score.toFixed(1);
}

export function formatClock(seconds?: number) {
  if (seconds === undefined) return "estimated";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function timeOnly(iso: string) {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso));
}

export function flag(countryCode: string) {
  return countryCode
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

export function athleteById(results: AthleteRoundResult[], id: string) {
  return results.find((result) => result.athlete.id === id);
}

export function countryName(code: string) {
  return regionNames.of(code) ?? code;
}
