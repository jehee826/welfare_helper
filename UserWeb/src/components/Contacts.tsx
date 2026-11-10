import type { Contact } from "../lib/api";
import { contactKindLabel } from "../lib/speech";

/** 검증된 연락처만 받는다. 출처·확인일은 표시하지 않는다. */
export function Contacts({ contacts }: { contacts: Contact[] }) {
  if (!contacts.length) return null;
  return (
    <section className="contacts" aria-labelledby="contacts-title">
      <h3 id="contacts-title">문의처</h3>
      <ul>
        {contacts.map((contact) => (
          <li key={`${contact.label}-${contact.phone}`} className="contact">
            <p className="contact-kind">{contactKindLabel(contact.kind)}</p>
            <p className="contact-label">{contact.label}</p>
            <a className="button contact-phone" href={`tel:${contact.phone.replace(/-/g, "")}`} aria-label={`${contact.label}에 전화 걸기, ${contact.phone}`}>
              전화 {contact.phone}
            </a>
            {contact.hours ? <p className="contact-hours">운영시간: {contact.hours}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
