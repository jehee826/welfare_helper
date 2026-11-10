import type { Contact } from "./chatApi";
import { contactKindLabel } from "./speech";

/** 검증된 연락처만 받는다. 출처·확인일은 표시하지 않는다. */
export function Contacts({ contacts }: { contacts: Contact[] }) {
  if (!contacts.length) return null;
  return (
    <section className="wc-contacts" aria-labelledby="contacts-title">
      <h3 id="contacts-title">문의처</h3>
      <ul>
        {contacts.map((contact) => (
          <li key={`${contact.label}-${contact.phone}`} className="wc-contact">
            <p className="wc-contact-kind">{contactKindLabel(contact.kind)}</p>
            <p className="wc-contact-label">{contact.label}</p>
            <a className="wc-button wc-contact-phone" href={`tel:${contact.phone.replace(/-/g, "")}`} aria-label={`${contact.label}에 전화 걸기, ${contact.phone}`}>
              전화 {contact.phone}
            </a>
            {contact.hours ? <p className="wc-contact-hours">운영시간: {contact.hours}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
