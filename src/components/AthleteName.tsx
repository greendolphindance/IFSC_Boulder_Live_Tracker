import type { ReactNode } from "react";
import type { Athlete } from "../../server/src/types/domain";

function athleteProfileUrl(id: string) {
  return `https://ifsc.results.info/athlete/${id}`;
}

export function AthleteName({ athlete, children, className }: { athlete: Athlete; children: ReactNode; className?: string }) {
  if (!athlete.id) {
    return <span className={className}>{children}</span>;
  }
  return (
    <a className={className ? `${className} name-link` : "name-link"} href={athleteProfileUrl(athlete.id)} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
