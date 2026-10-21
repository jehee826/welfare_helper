import type { WelfareProgram } from "../api/types";
import { ContactList } from "./ContactList";

export function AnswerCard({ text, services }: { text: string; services: WelfareProgram[] }) {
  return (
    <div className="bubble bubble--bot">
      <p className="bubble__text">{text}</p>
      <ul className="service-list">
        {services.map((s) => (
          <li key={s.id} className="service">
            <p className="service__meta">
              {s.ministry} · {s.department}
            </p>
            <h3 className="service__name">{s.name}</h3>
            <p className="service__summary">{s.summary}</p>
            <ContactList contacts={s.contacts} />
            <div className="service__foot">
              {s.url && (
                <a className="btn btn--soft btn--sm" href={s.url} target="_blank" rel="noopener noreferrer">
                  복지로에서 보기 ↗
                </a>
              )}
              <span className="muted small">기준일 {s.updatedAt}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
