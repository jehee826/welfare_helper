import type { Contact } from "../api/types";

export function ContactList({ contacts }: { contacts: Contact[] }) {
  return (
    <ul className="contacts" aria-label="문의처">
      {contacts.map((c) => (
        <li key={`${c.label}-${c.phone}`} className="contacts__item">
          <span>{c.label}</span>
          {c.phone && (
            <a className="contacts__phone" href={`tel:${c.phone}`}>
              ☏ {c.phone}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
